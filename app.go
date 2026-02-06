package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/sparkedhost/go-mysqldump"
	"github.com/xuri/excelize/v2"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context
	db  *sql.DB
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	_ = loadSavedConfigs()
}

// ConnectDB 连接数据库
func (a *App) ConnectDB(dsn string) error {
	// 如果已有连接，先关闭
	if a.db != nil {
		a.db.Close()
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库失败: %v", err)
	}

	// 检查连通性
	err = db.Ping()
	if err != nil {
		return fmt.Errorf("无法连接到数据库: %v", err)
	}

	a.db = db
	return nil
}

// ConnectDBConfig 使用配置连接数据库（避免特殊字符问题）
func (a *App) ConnectDBConfig(cfg DBConfig) error {
	dsn, err := buildDSN(cfg)
	if err != nil {
		return err
	}
	return a.ConnectDB(dsn)
}

// TestConnection 测试连接（不保留连接）
func (a *App) TestConnection(dsn string) error {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库失败: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		return fmt.Errorf("无法连接到数据库: %v", err)
	}
	return nil
}

// TestConnectionConfig 使用配置测试连接（避免特殊字符问题）
func (a *App) TestConnectionConfig(cfg DBConfig) error {
	dsn, err := buildDSN(cfg)
	if err != nil {
		return err
	}
	return a.TestConnection(dsn)
}

// ExecuteQuery 执行 SQL 并返回结果
func (a *App) ExecuteQuery(query string) ([]map[string]interface{}, error) {
	if a.db == nil {
		return nil, fmt.Errorf("数据库未连接")
	}

	rows, err := a.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 获取列名
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var result []map[string]interface{}

	for rows.Next() {
		// 创建一个切片用来存储扫描出的数据
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, err
		}

		// 将行数据转为 map
		rowMap := make(map[string]interface{})
		for i, col := range columns {
			val := values[i]
			// 处理 MySQL 的字节切片问题
			if b, ok := val.([]byte); ok {
				rowMap[col] = string(b)
			} else {
				rowMap[col] = val
			}
		}
		result = append(result, rowMap)
	}

	return result, nil
}

// QueryResult 返回带列顺序的结果
type QueryResult struct {
	Columns []string                 `json:"columns"`
	Rows    []map[string]interface{} `json:"rows"`
}

// ExecuteQueryWithColumns 执行 SQL 并返回列顺序与数据
func (a *App) ExecuteQueryWithColumns(query string) (QueryResult, error) {
	if a.db == nil {
		return QueryResult{}, fmt.Errorf("数据库未连接")
	}

	rows, err := a.db.Query(query)
	if err != nil {
		return QueryResult{}, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return QueryResult{}, err
	}

	var result []map[string]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			return QueryResult{}, err
		}
		rowMap := make(map[string]interface{})
		for i, col := range columns {
			val := values[i]
			if b, ok := val.([]byte); ok {
				rowMap[col] = string(b)
			} else {
				rowMap[col] = val
			}
		}
		result = append(result, rowMap)
	}

	return QueryResult{Columns: columns, Rows: result}, nil
}

// GetProcessList 获取会话列表
func (a *App) GetProcessList() ([]map[string]interface{}, error) {
	if a.db == nil {
		return nil, fmt.Errorf("数据库未连接")
	}
	rows, err := a.db.Query("SHOW FULL PROCESSLIST")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var result []map[string]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range columns {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, err
		}
		rowMap := make(map[string]interface{})
		for i, col := range columns {
			val := values[i]
			if b, ok := val.([]byte); ok {
				rowMap[col] = string(b)
			} else {
				rowMap[col] = val
			}
		}
		result = append(result, rowMap)
	}

	return result, nil
}

// KillProcess 终止会话
func (a *App) KillProcess(id int64) error {
	if a.db == nil {
		return fmt.Errorf("数据库未连接")
	}
	_, err := a.db.Exec(fmt.Sprintf("KILL %d", id))
	return err
}

type DBConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Database string `json:"database"`
}

type TableMeta struct {
	Name      string `json:"name"`
	Rows      int64  `json:"rows"`
	SizeBytes int64  `json:"sizeBytes"`
}

type ViewMeta struct {
	Name string `json:"name"`
}

type ColumnMeta struct {
	Table  string `json:"table"`
	Column string `json:"column"`
}

type TableStat struct {
	Name      string `json:"name"`
	Rows      int64  `json:"rows"`
	SizeBytes int64  `json:"sizeBytes"`
}

// 模拟内存存储，实际开发建议写入文件
var savedConfigs = []DBConfig{}

func configFilePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "dms-new", "connections.json")
	return path, nil
}

func loadSavedConfigs() error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var list []DBConfig
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	savedConfigs = list
	return nil
}

func persistSavedConfigs() error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(savedConfigs, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// GetSavedConnections 获取已保存的连接
func (a *App) GetSavedConnections() []DBConfig {
	return savedConfigs
}

// SaveConnection 保存新连接
func (a *App) SaveConnection(cfg DBConfig) error {
	// 简单校验
	if cfg.Name == "" || cfg.Host == "" || cfg.Port == 0 || cfg.User == "" {
		return fmt.Errorf("名称、主机、端口、用户名不能为空")
	}
	for _, c := range savedConfigs {
		if c.Name == cfg.Name {
			return fmt.Errorf("连接名称已存在")
		}
	}
	savedConfigs = append(savedConfigs, cfg)
	return persistSavedConfigs()
}

// UpdateConnection 更新连接
func (a *App) UpdateConnection(cfg DBConfig) error {
	if cfg.ID == "" {
		return fmt.Errorf("连接ID不能为空")
	}
	if cfg.Name == "" || cfg.Host == "" || cfg.Port == 0 || cfg.User == "" {
		return fmt.Errorf("名称、主机、端口、用户名不能为空")
	}
	for _, c := range savedConfigs {
		if c.Name == cfg.Name && c.ID != cfg.ID {
			return fmt.Errorf("连接名称已存在")
		}
	}
	for i, c := range savedConfigs {
		if c.ID == cfg.ID {
			savedConfigs[i] = cfg
			return persistSavedConfigs()
		}
	}
	return fmt.Errorf("未找到需要更新的连接")
}

// DeleteConnection 删除连接
func (a *App) DeleteConnection(id string) error {
	if id == "" {
		return fmt.Errorf("连接ID不能为空")
	}
	idx := -1
	for i, c := range savedConfigs {
		if c.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("未找到需要删除的连接")
	}
	savedConfigs = append(savedConfigs[:idx], savedConfigs[idx+1:]...)
	return persistSavedConfigs()
}

// GetDatabases 获取当前连接的所有数据库
func (a *App) GetDatabases() ([]string, error) {
	if a.db == nil {
		return nil, fmt.Errorf("请先连接数据库")
	}
	rows, err := a.db.Query("SHOW DATABASES")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dbs []string
	for rows.Next() {
		var dbName string
		if err := rows.Scan(&dbName); err != nil {
			return nil, err
		}
		dbs = append(dbs, dbName)
	}
	return dbs, nil
}

// GetDatabasesForConfig 使用配置获取数据库列表（不影响当前连接）
func (a *App) GetDatabasesForConfig(cfg DBConfig) ([]string, error) {
	dsn, err := buildDSN(cfg)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query("SHOW DATABASES")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dbs []string
	for rows.Next() {
		var dbName string
		if err := rows.Scan(&dbName); err != nil {
			return nil, err
		}
		dbs = append(dbs, dbName)
	}
	return dbs, nil
}

// GetTableStats 获取指定库的表统计
func (a *App) GetTableStats(cfg DBConfig, dbName string) ([]TableStat, error) {
	if dbName == "" {
		return nil, fmt.Errorf("数据库名不能为空")
	}
	cfg.Database = dbName
	dsn, err := buildDSN(cfg)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(
		`SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
		 FROM information_schema.tables
		 WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
		dbName,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []TableStat
	for rows.Next() {
		var name string
		var rowsCount sql.NullInt64
		var dataLen sql.NullInt64
		var indexLen sql.NullInt64
		if err := rows.Scan(&name, &rowsCount, &dataLen, &indexLen); err != nil {
			return nil, err
		}
		size := int64(0)
		if dataLen.Valid {
			size += dataLen.Int64
		}
		if indexLen.Valid {
			size += indexLen.Int64
		}
		stats = append(stats, TableStat{
			Name:      name,
			Rows:      rowsCount.Int64,
			SizeBytes: size,
		})
	}
	return stats, nil
}

// GetTables 获取指定库的表信息
func (a *App) GetTables(db string) ([]TableMeta, error) {
	if a.db == nil {
		return nil, fmt.Errorf("请先连接数据库")
	}
	if db == "" {
		return nil, fmt.Errorf("数据库名不能为空")
	}
	rows, err := a.db.Query(
		`SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
		 FROM information_schema.tables
		 WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
		db,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []TableMeta
	for rows.Next() {
		var name string
		var rowsCount sql.NullInt64
		var dataLen sql.NullInt64
		var indexLen sql.NullInt64
		if err := rows.Scan(&name, &rowsCount, &dataLen, &indexLen); err != nil {
			return nil, err
		}
		size := int64(0)
		if dataLen.Valid {
			size += dataLen.Int64
		}
		if indexLen.Valid {
			size += indexLen.Int64
		}
		tables = append(tables, TableMeta{
			Name:      name,
			Rows:      rowsCount.Int64,
			SizeBytes: size,
		})
	}
	return tables, nil
}

// GetViews 获取指定库的视图
func (a *App) GetViews(db string) ([]ViewMeta, error) {
	if a.db == nil {
		return nil, fmt.Errorf("请先连接数据库")
	}
	if db == "" {
		return nil, fmt.Errorf("数据库名不能为空")
	}
	rows, err := a.db.Query(
		`SELECT TABLE_NAME
		 FROM information_schema.tables
		 WHERE table_schema = ? AND table_type = 'VIEW'`,
		db,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var views []ViewMeta
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		views = append(views, ViewMeta{Name: name})
	}
	return views, nil
}

// GetColumns 获取指定库的字段信息
func (a *App) GetColumns(db string) ([]ColumnMeta, error) {
	if a.db == nil {
		return nil, fmt.Errorf("请先连接数据库")
	}
	if db == "" {
		return nil, fmt.Errorf("数据库名不能为空")
	}
	rows, err := a.db.Query(
		`SELECT TABLE_NAME, COLUMN_NAME
		 FROM information_schema.columns
		 WHERE table_schema = ?
		 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
		db,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []ColumnMeta
	for rows.Next() {
		var t, c string
		if err := rows.Scan(&t, &c); err != nil {
			return nil, err
		}
		cols = append(cols, ColumnMeta{Table: t, Column: c})
	}
	return cols, nil
}

// SaveExcelFile 弹出保存对话框并保存Excel文件
func (a *App) SaveExcelFile(suggestedName string, base64Data string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	if suggestedName == "" {
		suggestedName = "results.xlsx"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: suggestedName,
		Filters: []runtime.FileFilter{
			{DisplayName: "Excel", Pattern: "*.xlsx"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("文件编码错误: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// SaveExcelFromJSON 传入JSON数据，使用excelize生成Excel并保存
// 支持两种格式：
// 1) 纯数组：[{...}, {...}]
// 2) 包含表头顺序：{"headers":["a","b"],"rows":[{...}]}
func (a *App) SaveExcelFromJSON(suggestedName string, jsonData string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	if suggestedName == "" {
		suggestedName = "results.xlsx"
	}

	var payload struct {
		Headers []string               `json:"headers"`
		Rows    []map[string]interface{} `json:"rows"`
	}
	var rows []map[string]interface{}
	if err := json.Unmarshal([]byte(jsonData), &payload); err == nil && payload.Rows != nil {
		rows = payload.Rows
	} else {
		if err := json.Unmarshal([]byte(jsonData), &rows); err != nil {
			return "", fmt.Errorf("JSON解析失败: %v", err)
		}
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: suggestedName,
		Filters: []runtime.FileFilter{
			{DisplayName: "Excel", Pattern: "*.xlsx"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	f := excelize.NewFile()
	sheetName := f.GetSheetName(0)

	// Build header order
	headers := make([]string, 0)
	if len(payload.Headers) > 0 {
		headers = append(headers, payload.Headers...)
	} else {
		headerSet := make(map[string]struct{})
		for _, row := range rows {
			for k := range row {
				if _, ok := headerSet[k]; ok {
					continue
				}
				headerSet[k] = struct{}{}
				headers = append(headers, k)
			}
		}
	}

	cleaner := regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F]`)
	stringify := func(v interface{}) interface{} {
		switch t := v.(type) {
		case nil:
			return ""
		case string:
			return cleaner.ReplaceAllString(t, "")
		case []byte:
			return cleaner.ReplaceAllString(string(t), "")
		case map[string]interface{}, []interface{}:
			b, _ := json.Marshal(t)
			return cleaner.ReplaceAllString(string(b), "")
		default:
			return t
		}
	}

	// Write headers
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = f.SetCellValue(sheetName, cell, h)
	}
	// Write rows
	for r, row := range rows {
		for c, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(c+1, r+2)
			_ = f.SetCellValue(sheetName, cell, stringify(row[h]))
		}
	}

	if err := f.SaveAs(path); err != nil {
		return "", err
	}
	return path, nil
}

// SaveTextFile 弹出保存对话框并保存文本文件
func (a *App) SaveTextFile(suggestedName string, content string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	if suggestedName == "" {
		suggestedName = "export.sql"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: suggestedName,
		Filters: []runtime.FileFilter{
			{DisplayName: "SQL", Pattern: "*.sql"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// ExportSqlDump 使用开源库导出SQL（结构/数据/结构+数据）
func (a *App) ExportSqlDump(cfg DBConfig, tables []string, mode string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	if cfg.Host == "" || cfg.User == "" || cfg.Port == 0 || cfg.Database == "" {
		return "", fmt.Errorf("连接信息不完整")
	}
	if len(tables) == 0 {
		return "", fmt.Errorf("请选择至少一个表")
	}

	dsn, err := buildDSN(cfg)
	if err != nil {
		return "", err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return "", err
	}
	defer db.Close()

	allRows, err := db.Query(`SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`, cfg.Database)
	if err != nil {
		return "", err
	}
	defer allRows.Close()

	selected := map[string]bool{}
	for _, t := range tables {
		selected[t] = true
	}
	var ignore []string
	for allRows.Next() {
		var name string
		if err := allRows.Scan(&name); err != nil {
			return "", err
		}
		if !selected[name] {
			ignore = append(ignore, name)
		}
	}

	var buf strings.Builder
	dumper := mysqldump.Data{
		Out:          &buf,
		Connection:   db,
		IgnoreTables: ignore,
	}
	if err := dumper.Dump(); err != nil {
		return "", err
	}

	dumpText := buf.String()
	if mode == "schema" {
		dumpText = filterDump(dumpText, true, false)
	} else if mode == "data" {
		dumpText = filterDump(dumpText, false, true)
	}

	fileName := fmt.Sprintf("%s.sql", cfg.Database)
	return a.SaveTextFile(fileName, dumpText)
}

// SyncDatabase 同步数据库（结构/数据/结构+数据）
func (a *App) SyncDatabase(source DBConfig, sourceDB string, target DBConfig, targetDB string, mode string) (string, error) {
	if sourceDB == "" || targetDB == "" {
		return "", fmt.Errorf("源库和目标库不能为空")
	}
	source.Database = sourceDB
	target.Database = targetDB

	sourceDSN, err := buildDSN(source)
	if err != nil {
		return "", err
	}
	targetDSN, err := buildDSN(target)
	if err != nil {
		return "", err
	}
	srcDB, err := sql.Open("mysql", sourceDSN)
	if err != nil {
		return "", err
	}
	defer srcDB.Close()

	tgtDB, err := sql.Open("mysql", targetDSN)
	if err != nil {
		return "", err
	}
	defer tgtDB.Close()

	// 确保目标库存在
	_, err = tgtDB.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s`", targetDB))
	if err != nil {
		return "", err
	}

	var buf strings.Builder
	dumper := mysqldump.Data{
		Out:        &buf,
		Connection: srcDB,
	}
	if err := dumper.Dump(); err != nil {
		return "", err
	}

	dumpText := buf.String()
	if mode == "schema" {
		dumpText = filterDump(dumpText, true, false)
	} else if mode == "data" {
		dumpText = filterDump(dumpText, false, true)
	}

	_, _ = tgtDB.Exec("SET FOREIGN_KEY_CHECKS = 0")
	_, _ = tgtDB.Exec(fmt.Sprintf("USE `%s`", targetDB))
	stmts := strings.Split(dumpText, ";\n")
	for _, stmt := range stmts {
		s := strings.TrimSpace(stmt)
		if s == "" {
			continue
		}
		if _, err := tgtDB.Exec(s); err != nil {
			return "", err
		}
	}
	_, _ = tgtDB.Exec("SET FOREIGN_KEY_CHECKS = 1")

	return "同步完成", nil
}

func filterDump(input string, keepSchema bool, keepData bool) string {
	lines := strings.Split(input, "\n")
	var out []string
	inInsert := false
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "INSERT INTO") {
			inInsert = true
		}
		if inInsert {
			if keepData {
				out = append(out, line)
			}
			if strings.Contains(trim, ";") {
				inInsert = false
			}
			continue
		}

		if !keepSchema {
			continue
		}
		if strings.HasPrefix(trim, "LOCK TABLES") || strings.HasPrefix(trim, "UNLOCK TABLES") {
			continue
		}
		if strings.HasPrefix(trim, "INSERT INTO") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func buildDSN(cfg DBConfig) (string, error) {
	if cfg.Host == "" || cfg.User == "" || cfg.Port == 0 {
		return "", fmt.Errorf("连接信息不完整")
	}
	conf := mysqlDriver.NewConfig()
	conf.User = cfg.User
	conf.Passwd = cfg.Password
	conf.Net = "tcp"
	conf.Addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	conf.DBName = cfg.Database
	return conf.FormatDSN(), nil
}
