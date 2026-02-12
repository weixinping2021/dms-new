import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import Editor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import './App.css';
import {
  Layout, Menu, Button, Modal, Form, Input,
  Table, Card, Space, Typography, message,
  Divider, Tooltip, Tabs, InputNumber, Select, Switch,
  Radio
} from 'antd';
import {
  PlusOutlined, DatabaseOutlined, ConsoleSqlOutlined,
  ReloadOutlined, DesktopOutlined,
  TableOutlined, EditOutlined, DeleteOutlined,
  ExclamationCircleOutlined, ThunderboltOutlined, CaretRightOutlined,
  FileTextOutlined
} from '@ant-design/icons';
import mysqlLogo from './assets/images/mysql.svg';
import { EventsOn } from '../wailsjs/runtime/runtime';

// @ts-ignore - 引入 Wails 自动生成的后端接口
import {
  ConnectDB,
  ConnectDBConfig,
  ExecuteQuery,
  ExecuteQueryWithColumns,
  GetSavedConnections,
  SaveConnection,
  GetDatabases,
  GetColumns,
  GetTables,
  GetViews,
  UpdateConnection,
  DeleteConnection,
  TestConnection,
  TestConnectionConfig,
  SaveExcelFromJSON,
  ExportSqlDump,
  GetProcessList,
  GetAppSettings,
  KillProcess,
  GetDatabasesForConfig,
  GetTableStats,
  SaveAppSettings,
  SyncDatabase
} from '../wailsjs/go/main/App';
const { Sider, Content, Header } = Layout;
const { Text, Title } = Typography;

type DBConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

type TableMeta = {
  name: string;
  rows: number;
  sizeBytes: number;
};

type ViewMeta = {
  name: string;
};

type ColumnMeta = {
  table: string;
  column: string;
};

type QueryTab = {
  key: string;
  title: string;
  sql: string;
  columns: any[];
  data: any[];
  loading: boolean;
  kind?: 'query' | 'ddl' | 'session' | 'migration';
  content?: string;
  durationMs?: number;
  connId?: string;
  dbName?: string;
  migration?: MigrationState;
  results?: Array<{ key: string; title: string; columns: any[]; data: any[]; durationMs?: number }>;
  activeResultKey?: string;
};

type MenuItem = {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  children?: MenuItem[];
  disabled?: boolean;
};

type ConnStatus = 'connected' | 'disconnected' | 'error' | 'connecting';

type MigrationState = {
  sourceConnId: string;
  sourceDb: string;
  sourceTables: string[];
  targetConnId: string;
  targetDb: string;
  mode: 'schema' | 'data' | 'both';
  check: Array<{ name: string; sourceRows: number; targetRows: number; status: string }>;
};

const App: React.FC = () => {
  // --- 状态管理 ---
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [connLoading, setConnLoading] = useState(false);
  const [connections, setConnections] = useState<DBConfig[]>([]); // 已保存的连接列表
  const [dbList, setDbList] = useState<Record<string, string[]>>({}); // 每个连接对应的数据库列表
  const [tableList, setTableList] = useState<Record<string, Record<string, TableMeta[]>>>({});
  const [viewList, setViewList] = useState<Record<string, Record<string, ViewMeta[]>>>({});
  const [connStatus, setConnStatus] = useState<Record<string, ConnStatus>>({});
  const [activeConn, setActiveConn] = useState<DBConfig | null>(null); // 当前选中的连接
  const [currentDb, setCurrentDb] = useState<string | null>(null); // 当前选中的数据库名
  const [editingConn, setEditingConn] = useState<DBConfig | null>(null);
  const [exportDb, setExportDb] = useState<{ conn: DBConfig; db: string } | null>(null);
  const [exportTables, setExportTables] = useState<string[]>([]);
  const [exportSearch, setExportSearch] = useState('');
  const [exportMode, setExportMode] = useState<'schema' | 'data' | 'both'>('schema');
  const [exportLogs, setExportLogs] = useState<string[]>([]);
  const exportLogRef = useRef<HTMLDivElement | null>(null);
  const [appSettings, setAppSettings] = useState<{ mysqldumpPath: string }>({ mysqldumpPath: '' });
  const [sessionRows, setSessionRows] = useState<any[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionCommand, setSessionCommand] = useState<string | undefined>(undefined);
  const [sessionUser, setSessionUser] = useState<string | undefined>(undefined);
  const [sessionDb, setSessionDb] = useState<string | undefined>(undefined);
  const [sessionSqlSearch, setSessionSqlSearch] = useState('');
  const [siderOpenKeys, setSiderOpenKeys] = useState<string[]>([]);
  const [migrationSourceConn, setMigrationSourceConn] = useState<string>('');
  const [migrationSourceDb, setMigrationSourceDb] = useState<string>('');
  const [migrationSourceTables, setMigrationSourceTables] = useState<string[]>([]);
  const [migrationTargetConn, setMigrationTargetConn] = useState<string>('');
  const [migrationTargetDb, setMigrationTargetDb] = useState<string>('');
  const [migrationMode, setMigrationMode] = useState<'schema' | 'data' | 'both'>('both');
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [migrationCheck, setMigrationCheck] = useState<Array<{ name: string; sourceRows: number; targetRows: number; status: string }>>([]);
  const [migrationSources, setMigrationSources] = useState<Record<string, string[]>>({});
  const [migrationTargets, setMigrationTargets] = useState<Record<string, string[]>>({});
  const [sessionAuto, setSessionAuto] = useState(false);
  const [sessionInterval, setSessionInterval] = useState(5);
  const [selectedSessionIds, setSelectedSessionIds] = useState<number[]>([]);
  const [dbFilter, setDbFilter] = useState('');

  const [queryTabs, setQueryTabs] = useState<QueryTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string>('');
  const [sqlPaneHeight, setSqlPaneHeight] = useState<number>(380);
  const isResizingRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const tabSeq = useRef(1);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const suggestionRef = useRef<{ tables: string[]; columns: Array<{ table: string; column: string }> }>({
    tables: [],
    columns: []
  });
  const completionRegistered = useRef(false);

  const [form] = Form.useForm();

  // --- 初始化 ---
  useEffect(() => {
    fetchSavedConnections();
    loadAppSettings();
    ensureInitialTab();
  }, []);

  const ensureInitialTab = () => {
    if (queryTabs.length === 0) {
      const first = createTab();
      setQueryTabs([first]);
      setActiveTabKey(first.key);
    }
  };

  const fetchSavedConnections = async () => {
    try {
      const res = await GetSavedConnections();
      const list = (res || []) as DBConfig[];
      setConnections(list);
      setConnStatus(prev => {
        const next: Record<string, ConnStatus> = { ...prev };
        list.forEach(conn => {
          if (!next[conn.id]) next[conn.id] = 'disconnected';
        });
        return next;
      });
    } catch (err) {
      message.error('获取保存的连接失败');
    }
  };

  const loadAppSettings = async () => {
    try {
      const res = await GetAppSettings();
      setAppSettings({ mysqldumpPath: res?.mysqldumpPath || '' });
    } catch (err) {
      message.error('获取设置失败');
    }
  };

  // --- 业务逻辑 ---

  const createTab = () => {
    const seq = tabSeq.current++;
    return {
      key: `query-${Date.now()}-${seq}`,
      title: `Query ${seq}`,
      sql: 'SHOW TABLES;',
      columns: [],
      data: [],
      loading: false,
      kind: 'query',
      content: '',
      connId: activeConn?.id,
      dbName: currentDb || undefined
    } as QueryTab;
  };

  const addTab = () => {
    const next = createTab();
    setQueryTabs(prev => [...prev, next]);
    setActiveTabKey(next.key);
  };

  const removeTab = (targetKey: string) => {
    setQueryTabs(prev => {
      const next = prev.filter(tab => tab.key !== targetKey);
      if (next.length === 0) {
        const fallback = createTab();
        setActiveTabKey(fallback.key);
        return [fallback];
      }
      if (activeTabKey === targetKey) {
        setActiveTabKey(next[next.length - 1].key);
      }
      return next;
    });
  };

  const updateTab = (key: string, patch: Partial<QueryTab>) => {
    setQueryTabs(prev => prev.map(tab => (tab.key === key ? { ...tab, ...patch } : tab)));
  };

  const updateActiveTab = (patch: Partial<QueryTab>) => {
    if (!activeTabKey) return;
    updateTab(activeTabKey, patch);
  };

  const activeTab = useMemo(
    () => queryTabs.find(tab => tab.key === activeTabKey) || null,
    [queryTabs, activeTabKey]
  );

  useEffect(() => {
    if (activeTab?.kind !== 'migration') return;
    const state = activeTab.migration;
    if (!state) {
      setMigrationSourceConn('');
      setMigrationSourceDb('');
      setMigrationSourceTables([]);
      setMigrationTargetConn('');
      setMigrationTargetDb('');
      setMigrationMode('both');
      setMigrationCheck([]);
      return;
    }
    setMigrationSourceConn(state.sourceConnId);
    setMigrationSourceDb(state.sourceDb);
    setMigrationSourceTables(state.sourceTables);
    setMigrationTargetConn(state.targetConnId);
    setMigrationTargetDb(state.targetDb);
    setMigrationMode(state.mode);
    setMigrationCheck(state.check);
  }, [activeTab?.key, activeTab?.kind]);

  useEffect(() => {
    if (activeTab?.kind !== 'migration') return;
    updateActiveTab({
      connId: migrationSourceConn || undefined,
      dbName: migrationSourceDb || undefined,
      migration: {
        sourceConnId: migrationSourceConn,
        sourceDb: migrationSourceDb,
        sourceTables: migrationSourceTables,
        targetConnId: migrationTargetConn,
        targetDb: migrationTargetDb,
        mode: migrationMode,
        check: migrationCheck
      }
    });
  }, [
    activeTab?.key,
    activeTab?.kind,
    migrationSourceConn,
    migrationSourceDb,
    migrationSourceTables,
    migrationTargetConn,
    migrationTargetDb,
    migrationMode,
    migrationCheck
  ]);



  const parseAliasMap = (sqlText: string) => {
    const map: Record<string, string> = {};
    const cleaned = sqlText.replace(/\s+/g, ' ');
    const regex = /\b(from|join)\s+`?([a-zA-Z0-9_]+)`?(?:\s+as)?\s+`?([a-zA-Z0-9_]+)`?/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      const table = match[2];
      const alias = match[3];
      if (alias && alias !== table) {
        map[alias] = table;
      }
    }
    return map;
  };


  // 1. 保存新连接 / 更新连接
  const handleSaveConnection = async (values: any) => {
    try {
      if (editingConn) {
        const updated = { ...editingConn, ...values } as DBConfig;
        await UpdateConnection(updated);
        message.success('连接已更新');
        if (activeConn?.id === updated.id) {
          setActiveConn(updated);
        }
      } else {
        const newConn = { ...values, id: Date.now().toString() } as DBConfig;
        await SaveConnection(newConn);
        message.success('连接配置已保存');
      }
      setIsModalOpen(false);
      setEditingConn(null);
      form.resetFields();
      await fetchSavedConnections();
    } catch (err) {
      message.error('保存失败: ' + err);
    }
  };

  const openCreateModal = () => {
    setEditingConn(null);
    form.resetFields();
    form.setFieldsValue({ port: 3306 });
    setIsModalOpen(true);
  };

  const openEditModal = (conn: DBConfig) => {
    setEditingConn(conn);
    form.setFieldsValue({
      name: conn.name,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database
    });
    setIsManagerOpen(false);
    setIsModalOpen(true);
  };

  const handleDeleteConnection = (conn: DBConfig) => {
    Modal.confirm({
      title: `删除连接 ${conn.name}?`,
      icon: <ExclamationCircleOutlined />,
      content: '该操作不会删除数据库，仅移除本地连接配置。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          await DeleteConnection(conn.id);
          message.success('连接已删除');
          if (activeConn?.id === conn.id) {
            setActiveConn(null);
            setCurrentDb(null);
          }
          setDbList(prev => {
            const next = { ...prev };
            delete next[conn.id];
            return next;
          });
          setTableList(prev => {
            const next = { ...prev };
            delete next[conn.id];
            return next;
          });
          setViewList(prev => {
            const next = { ...prev };
            delete next[conn.id];
            return next;
          });
          await fetchSavedConnections();
        } catch (err) {
          message.error('删除失败: ' + err);
        }
      }
    });
  };

  const handleTestConnection = async () => {
    try {
      const values = await form.validateFields(['host', 'port', 'user', 'password', 'database']);
      const temp = {
        id: editingConn?.id || 'temp',
        name: editingConn?.name || 'temp',
        host: values.host,
        port: values.port || 3306,
        user: values.user,
        password: values.password || '',
        database: values.database || ''
      } as DBConfig;
      await TestConnectionConfig(temp);
      message.success('连接测试成功');
    } catch (err) {
      if (err && (err as any).errorFields) return;
      message.error('连接测试失败: ' + err);
    }
  };

  // 2. 连接并加载数据库列表 (对应 Navicat 双击连接)
  const handleConnect = async (conn: DBConfig) => {
    setConnLoading(true);
    setConnStatus(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(id => {
        next[id] = id === conn.id ? 'connecting' : 'disconnected';
      });
      return next;
    });
    try {
      await ConnectDBConfig(conn);
      setActiveConn(conn);
      setCurrentDb(null);
      setConnStatus(prev => ({ ...prev, [conn.id]: 'connected' }));
      // 获取该连接下的库名
      const dbs = await GetDatabases();
      setDbList(prev => ({ ...prev, [conn.id]: dbs }));
      message.success(`成功连接到 ${conn.name}`);
    } catch (err) {
      setConnStatus(prev => ({ ...prev, [conn.id]: 'error' }));
      message.error(`连接失败: ${err}`);
    } finally {
      setConnLoading(false);
    }
  };

  // 3. 切换数据库并加载表
  const handleSelectDb = async (conn: DBConfig, dbName: string) => {
    try {
      await ConnectDBConfig(conn);
      await ExecuteQuery(`USE \`${dbName}\``);
      updateActiveTab({ connId: conn.id, dbName });
      message.info(`当前数据库: ${dbName}`);
      const cols = await GetColumns(dbName);
      const tables = await GetTables(dbName);
      const views = await GetViews(dbName);
      suggestionRef.current = {
        tables: (tables || []).map(t => t.name),
        columns: (cols || []).map(c => ({ table: c.table, column: c.column }))
      };
      setTableList(prev => ({
        ...prev,
        [conn.id]: {
          ...(prev[conn.id] || {}),
          [dbName]: tables || []
        }
      }));
      setViewList(prev => ({
        ...prev,
        [conn.id]: {
          ...(prev[conn.id] || {}),
          [dbName]: views || []
        }
      }));
    } catch (err) {
      message.error('切换数据库失败');
    }
  };

  const loadDbObjects = async (conn: DBConfig, dbName: string) => {
    try {
      await ConnectDBConfig(conn);
      await ExecuteQuery(`USE \`${dbName}\``);
      const tables = await GetTables(dbName);
      const views = await GetViews(dbName);
      setTableList(prev => ({
        ...prev,
        [conn.id]: {
          ...(prev[conn.id] || {}),
          [dbName]: tables || []
        }
      }));
      setViewList(prev => ({
        ...prev,
        [conn.id]: {
          ...(prev[conn.id] || {}),
          [dbName]: views || []
        }
      }));
    } catch (err) {
      message.error('加载表/视图失败');
    }
  };

  const openExportModal = async (conn: DBConfig, dbName: string) => {
    let tables = tableList[conn.id]?.[dbName] || [];
    if (tables.length === 0) {
      try {
        await ConnectDBConfig(conn);
        await ExecuteQuery(`USE \`${dbName}\``);
        const fetched = await GetTables(dbName);
        tables = fetched || [];
        setTableList(prev => ({
          ...prev,
          [conn.id]: {
            ...(prev[conn.id] || {}),
            [dbName]: tables
          }
        }));
      } catch (err) {
        message.error('加载表失败: ' + err);
      }
    }
    setExportDb({ conn, db: dbName });
    setExportTables(tables.map(t => t.name));
    setExportSearch('');
    setExportMode('schema');
    setIsExportOpen(true);
  };

  const fetchSessions = async (connId?: string) => {
    setSessionLoading(true);
    try {
      const id = connId || activeTab?.connId;
      if (id) {
        const conn = connections.find(c => c.id === id);
        if (conn) {
          await ConnectDBConfig(conn);
        }
      }
      const rows = await GetProcessList();
      const normalized = (rows || []).map((r: any) => ({
        id: Number(r.Id ?? r.id ?? r.ID),
        user: r.User ?? r.user,
        host: r.Host ?? r.host,
        db: r.db ?? r.DB,
        command: r.Command ?? r.command,
        time: r.Time ?? r.time,
        state: r.State ?? r.state,
        info: r.Info ?? r.info
      }));
      setSessionRows(normalized);
    } catch (err) {
      message.error('获取会话失败: ' + err);
    } finally {
      setSessionLoading(false);
    }
  };

  const openSessionTab = () => {
    const key = `session-${Date.now()}`;
    const next: QueryTab = {
      key,
      title: '会话管理',
      sql: '',
      columns: [],
      data: [],
      loading: false,
      kind: 'session',
      content: '',
      connId: activeConn?.id,
      dbName: currentDb || undefined
    };
    setQueryTabs(prev => {
      const filtered = prev.filter(tab => tab.kind !== 'query' || tab.sql !== '');
      return [...filtered, next];
    });
    setActiveTabKey(key);
    fetchSessions(next.connId);
  };

  const openMigrationTab = () => {
    const existing = queryTabs.find(tab => tab.kind === 'migration');
    if (existing) {
      setActiveTabKey(existing.key);
      return;
    }
    const key = `migration-${Date.now()}`;
    const next: QueryTab = {
      key,
      title: '数据库迁移',
      sql: '',
      columns: [],
      data: [],
      loading: false,
      kind: 'migration',
      content: '',
      migration: {
        sourceConnId: '',
        sourceDb: '',
        sourceTables: [],
        targetConnId: '',
        targetDb: '',
        mode: 'both',
        check: []
      }
    };
    setMigrationSourceConn('');
    setMigrationSourceDb('');
    setMigrationSourceTables([]);
    setMigrationTargetConn('');
    setMigrationTargetDb('');
    setMigrationMode('both');
    setMigrationCheck([]);
    setQueryTabs(prev => {
      const filtered = prev.filter(tab => !(tab.kind === 'query' && !tab.sql.trim() && (!tab.results || tab.results.length === 0)));
      return [...filtered, next];
    });
    setActiveTabKey(key);
  };

  const loadDbListFor = async (connId: string, type: 'source' | 'target') => {
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;
    try {
      const list = await GetDatabasesForConfig(conn);
      if (type === 'source') {
        setMigrationSources(prev => ({ ...prev, [connId]: list }));
      } else {
        setMigrationTargets(prev => ({ ...prev, [connId]: list }));
      }
      return list;
    } catch (err) {
      message.error('获取数据库列表失败: ' + err);
    }
  };

  const loadMigrationSourceTree = async (connId: string) => {
    setMigrationSourceDb('');
    const list = await loadDbListFor(connId, 'source');
    setMigrationSourceTables([]);
  };

  const loadMigrationSourceTables = async (connId: string, dbName: string) => {
    if (!connId || !dbName) return;
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;
    try {
      await ConnectDBConfig(conn);
      await ExecuteQuery(`USE \`${dbName}\``);
      const tables = await GetTables(dbName);
      setTableList(prev => ({
        ...prev,
        [connId]: {
          ...(prev[connId] || {}),
          [dbName]: tables || []
        }
      }));
    } catch (err) {
      message.error('加载表失败: ' + err);
    }
  };

  const buildMigrationCheckRows = async () => {
    const sourceConn = connections.find(c => c.id === migrationSourceConn);
    const targetConn = connections.find(c => c.id === migrationTargetConn);
    if (!sourceConn || !targetConn) {
      message.warning('请选择源实例和目标实例');
      return [];
    }
    if (!migrationSourceDb || !migrationTargetDb) {
      message.warning('未找到源或目标数据库');
      return [];
    }

    const sourceStats = await GetTableStats(sourceConn, migrationSourceDb);
    const targetStats = await GetTableStats(targetConn, migrationTargetDb);
    const targetMap = new Map(targetStats.map(t => [t.name, t]));
    const selected = migrationSourceTables.length > 0 ? new Set(migrationSourceTables) : null;
    const filteredSource = selected ? sourceStats.filter(s => selected.has(s.name)) : sourceStats;

    return filteredSource.map(s => {
      const target = targetMap.get(s.name);
      const targetRows = target ? target.rows : 0;
      const reasons: string[] = [];

      if ((migrationMode === 'schema' || migrationMode === 'both') && target) {
        reasons.push('目标已存在同名表');
      }
      if ((migrationMode === 'data' || migrationMode === 'both') && target && targetRows > 0) {
        reasons.push('目标表有数据');
      }
      if (!target) {
        reasons.push('目标不存在');
      }

      const status = reasons.some(r => r.includes('目标已存在同名表') || r.includes('目标表有数据'))
        ? `检测不通过 - ${reasons.filter(r => r !== '目标不存在').join('、')}`
        : `通过${reasons.includes('目标不存在') ? '（目标不存在）' : ''}`;

      return { name: s.name, sourceRows: s.rows, targetRows, status };
    });
  };

  const runMigrationCheck = async () => {
    setMigrationLoading(true);
    try {
      const rows = await buildMigrationCheckRows();
      setMigrationCheck(rows);
    } catch (err) {
      message.error('预检查失败: ' + err);
    } finally {
      setMigrationLoading(false);
    }
  };

  const runMigration = async () => {
    const sourceConn = connections.find(c => c.id === migrationSourceConn);
    const targetConn = connections.find(c => c.id === migrationTargetConn);
    if (!sourceConn || !targetConn) {
      message.warning('请选择源实例和目标实例');
      return;
    }
    if (!migrationSourceDb || !migrationTargetDb) {
      message.warning('未找到源或目标数据库');
      return;
    }
    setMigrationLoading(true);
    try {
      const rows = await buildMigrationCheckRows();
      const hasBlock = rows.some(r => String(r.status).startsWith('检测不通过'));
      setMigrationCheck(rows);
      if (hasBlock) {
        message.error('检测不通过：目标库存在冲突表/数据');
        return;
      }
      const resultRows = await SyncDatabase(sourceConn, migrationSourceDb, targetConn, migrationTargetDb, migrationMode, migrationSourceTables);
      setMigrationCheck(resultRows as any);
      const failed = (resultRows || []).filter((r: any) => String(r.status || '').startsWith('failed'));
      if (failed.length > 0) {
        message.warning(`同步完成（失败 ${failed.length} 张表）`);
      } else {
        message.success('同步完成');
      }
    } catch (err) {
      message.error('同步失败: ' + err);
    } finally {
      setMigrationLoading(false);
    }
  };

  const killSession = async (id: number) => {
    try {
      await KillProcess(id);
      message.success('会话已终止');
      fetchSessions(activeTab?.connId);
    } catch (err) {
      message.error('终止会话失败: ' + err);
    }
  };

  const killSelectedSessions = () => {
    if (selectedSessionIds.length === 0) {
      message.info('请先选择会话');
      return;
    }
    Modal.confirm({
      title: `终止选中的 ${selectedSessionIds.length} 个会话？`,
      okText: '终止',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          for (const id of selectedSessionIds) {
            await KillProcess(id);
          }
          message.success('已终止选中会话');
          setSelectedSessionIds([]);
          fetchSessions(activeTab?.connId);
        } catch (err) {
          message.error('终止会话失败: ' + err);
        }
      }
    });
  };

  const killUserSessions = () => {
    if (!sessionUser) {
      message.info('请选择一个用户');
      return;
    }
    const ids = filteredSessions.filter(r => r.user === sessionUser).map(r => r.id);
    if (ids.length === 0) {
      message.info('没有可终止的会话');
      return;
    }
    Modal.confirm({
      title: `终止用户 ${sessionUser} 的 ${ids.length} 个会话？`,
      okText: '终止',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        try {
          for (const id of ids) {
            await KillProcess(id);
          }
          message.success('已终止该用户会话');
          setSelectedSessionIds([]);
          fetchSessions(activeTab?.connId);
        } catch (err) {
          message.error('终止会话失败: ' + err);
        }
      }
    });
  };

  useEffect(() => {
    if (!sessionAuto || activeTab?.kind !== 'session') return;
    const ms = Math.max(1, sessionInterval) * 1000;
    const timer = setInterval(() => fetchSessions(activeTab?.connId), ms);
    return () => clearInterval(timer);
  }, [sessionAuto, sessionInterval, activeTab?.key, activeTab?.kind, activeTab?.connId]);

  // 迁移页不再实时打印日志到前端

  useEffect(() => {
    if (!isExportOpen) return;
    setExportLogs([]);
    const off = EventsOn('export-log', (msg: string) => {
      setExportLogs(prev => [...prev, msg]);
    });
    return () => off();
  }, [isExportOpen]);

  useEffect(() => {
    if (!exportLogRef.current) return;
    exportLogRef.current.scrollTop = exportLogRef.current.scrollHeight;
  }, [exportLogs.length]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      if (!workspaceRef.current) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      const minSql = 200;
      const minResult = 100;
      const next = Math.max(minSql, Math.min(e.clientY - rect.top, rect.height - minResult));
      setSqlPaneHeight(next);
    };
    const handleUp = () => {
      isResizingRef.current = false;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const handleExportSql = async () => {
    if (!exportDb) return;
    if (exportTables.length === 0) {
      message.warning('请选择至少一个表');
      return;
    }
    try {
      await SaveAppSettings(appSettings);
      const savedPath = await ExportSqlDump({ ...exportDb.conn, database: exportDb.db }, exportTables, exportMode);
      if (!savedPath) {
        message.info('已取消导出');
        return;
      }
      message.success('导出成功');
      //setIsExportOpen(false);
    } catch (err) {
      message.error('导出失败: ' + err);
    }
  };

  const exportResultToExcel = async (resultKey: string) => {
    const tab = activeTab;
    if (!tab) return;
    const result = (tab.results || []).find(r => r.key === resultKey);
    if (!result) return;
    if (!result.data || result.data.length === 0) {
      message.warning('当前结果为空，无法导出');
      return;
    }
    try {
      const sanitizeExcelValue = (value: any) => {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string') {
          return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        }
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return value;
      };
      const safeRows = result.data.map(row => {
        const next: Record<string, any> = {};
        Object.keys(row || {}).forEach(key => {
          next[key] = sanitizeExcelValue((row as any)[key]);
        });
        return next;
      });
      const name = (result.title || 'result').replace(/[\\/:*?"<>|]+/g, '_');
      const headers = (result.columns || []).map((c: any) => c.dataIndex || c.key || c.title).filter(Boolean);
      const payload = JSON.stringify({ headers, rows: safeRows });
      const savedPath = await SaveExcelFromJSON(`${name}.xlsx`, payload);
      if (!savedPath) {
        message.info('已取消导出');
        return;
      }
      message.success('导出成功');
    } catch (err) {
      message.error('导出失败: ' + err);
    }
  };

  // 4. 运行 SQL
  const runSqlText = async (tabKey: string, sqlText: string) => {
    if (!sqlText.trim()) return;
    const tab = queryTabs.find(t => t.key === tabKey);
    if (!tab?.connId) {
      message.warning('请先为该 Tab 选择连接与库');
      return;
    }
    const conn = connections.find(c => c.id === tab.connId);
    if (!conn) {
      message.warning('连接不存在，请重新选择');
      return;
    }
    updateTab(tabKey, { loading: true });
    try {
      await ConnectDBConfig(conn);
      if (tab.dbName) {
        await ExecuteQuery(`USE \`${tab.dbName}\``);
      }
      const start = performance.now();
      const result = await ExecuteQueryWithColumns(sqlText);
      const durationMs = Math.round(performance.now() - start);
      const data = result?.rows || [];
      const orderedCols = result?.columns || [];
      if (data && data.length > 0) {
        const cols = orderedCols.map(k => ({
          title: k,
          dataIndex: k,
          key: k,
          ellipsis: true,
          width: 150
        }));
        const resultKey = `result-${Date.now()}`;
        const resultTitle = `结果 ${new Date().toLocaleTimeString()}`;
        updateTab(tabKey, {
          columns: cols,
          data,
          durationMs,
          activeResultKey: resultKey,
          results: [
            ...(tab.results || []),
            { key: resultKey, title: resultTitle, columns: cols, data, durationMs }
          ]
        });
      } else {
        const resultKey = `result-${Date.now()}`;
        const resultTitle = `结果 ${new Date().toLocaleTimeString()}`;
        updateTab(tabKey, {
          data: [],
          columns: [],
          durationMs,
          activeResultKey: resultKey,
          results: [
            ...(tab.results || []),
            { key: resultKey, title: resultTitle, columns: [], data: [], durationMs }
          ]
        });
        message.warning('执行成功，但结果集为空');
      }
    } catch (err) {
      message.error(`SQL错误: ${err}`);
    } finally {
      updateTab(tabKey, { loading: false });
    }
  };

  const runSelectedSql = async (tabKey: string) => {
    const editor = editorRef.current;
    if (!editor) {
      await executeTabSql(tabKey);
      return;
    }
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model || selection.isEmpty()) {
      await executeTabSql(tabKey);
      return;
    }
    const text = model.getValueInRange(selection).trim();
    if (!text) {
      await executeTabSql(tabKey);
      return;
    }
    await runSqlText(tabKey, text);
  };

  const resetSql = (tabKey: string) => {
    updateTab(tabKey, { sql: '' });
  };

  const parseStatements = (sqlText: string) => {
    return sqlText
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
  };

  const executeTabSql = async (tabKey: string) => {
    const tab = queryTabs.find(t => t.key === tabKey);
    if (!tab) return;
    const editor = editorRef.current;
    const selection = editor?.getModel() && editor.getSelection()
      ? editor.getModel()!.getValueInRange(editor.getSelection()!)
      : '';
    const sqlText = selection.trim().length > 0 ? selection : tab.sql;
    if (!sqlText.trim()) return;
    const statements = parseStatements(sqlText);
    if (statements.length > 2) {
      message.warning('无法一次性执行超过两个语句');
      return;
    }
    if (statements.length === 1) {
      await runSqlText(tabKey, statements[0]);
      return;
    }
    updateTab(tabKey, { loading: true });
    try {
      const start = performance.now();
      let lastData: any[] = [];
      let lastColumns: string[] = [];
      for (const stmt of statements) {
        const result = await ExecuteQueryWithColumns(stmt);
        lastData = result?.rows || [];
        lastColumns = result?.columns || [];
      }
      const durationMs = Math.round(performance.now() - start);
      if (lastData && lastData.length > 0) {
        const cols = lastColumns.map(k => ({
          title: k,
          dataIndex: k,
          key: k,
          ellipsis: true,
          width: 150
        }));
        updateTab(tabKey, { columns: cols, data: lastData, durationMs });
      } else {
        updateTab(tabKey, { data: [], columns: [], durationMs });
        message.warning('执行成功，但结果集为空');
      }
    } catch (err) {
      message.error(`SQL错误: ${err}`);
    } finally {
      updateTab(tabKey, { loading: false });
    }
  };

  const exportActiveToExcel = async () => {
    if (!activeTab || activeTab.kind === 'ddl') return;
    const rows = activeTab.data || [];
    if (!rows.length) {
      message.info('没有可导出的数据');
      return;
    }
    const sanitizeExcelValue = (value: any) => {
      if (value === null || value === undefined) return value;
      if (typeof value === 'string') {
        return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value;
    };
    const safeRows = rows.map(row => {
      const next: Record<string, any> = {};
      Object.keys(row || {}).forEach(key => {
        next[key] = sanitizeExcelValue((row as any)[key]);
      });
      return next;
    });
    const name = (activeTab.title || 'results').replace(/[\\/:*?"<>|]+/g, '_');
    try {
      const headers = (activeTab.columns || []).map((c: any) => c.dataIndex || c.key || c.title).filter(Boolean);
      const payload = JSON.stringify({ headers, rows: safeRows });
      const savedPath = await SaveExcelFromJSON(`${name}.xlsx`, payload);
      if (!savedPath) {
        message.info('已取消导出');
        return;
      }
      message.success('导出成功');
    } catch (err) {
      message.error('导出失败: ' + err);
    }
  };

  const addQueryTabWithSql = (sql: string, title?: string) => {
    const next = createTab();
    next.sql = sql;
    if (title) next.title = title;
    setQueryTabs(prev => [...prev, next]);
    setActiveTabKey(next.key);
    return next.key;
  };

  const truncateCellText = (value: any, maxLen: number) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : String(value);
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  };

  const copyCellText = async (value: any) => {
    const text = value === null || value === undefined ? '' : String(value);
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      message.success('已复制完整内容');
    } catch (err) {
      message.error('复制失败');
    }
  };

  const addDdlTab = (title: string, content: string) => {
    const key = `ddl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const next: QueryTab = {
      key,
      title,
      sql: '',
      columns: [],
      data: [],
      loading: false,
      kind: 'ddl',
      content,
      connId: activeConn?.id,
      dbName: currentDb || undefined
    };
    setQueryTabs(prev => [...prev, next]);
    setActiveTabKey(key);
  };

  const addQueryTabForDb = async (conn: DBConfig, db: string, sql: string, title?: string) => {
    try {
      await ConnectDBConfig(conn);
      await ExecuteQuery(`USE \`${db}\``);
      const tabKey = addQueryTabWithSql(sql, title);
      updateTab(tabKey, { connId: conn.id, dbName: db });
      setTimeout(() => runSqlText(tabKey, sql), 0);
    } catch (err) {
      message.error('切换数据库失败: ' + err);
    }
  };

  const showTableDdl = async (conn: DBConfig, db: string, table: string, isView: boolean) => {
    try {
      await ConnectDBConfig(conn);
      await ExecuteQuery(`USE \`${db}\``);
      const sql = isView
        ? `SHOW CREATE VIEW \`${table}\`;`
        : `SHOW CREATE TABLE \`${table}\`;`;
      const result = await ExecuteQuery(sql);
      const first = result && result[0] ? result[0] : {};
      const ddlKey = Object.keys(first).find(k => k.toLowerCase().includes('create')) || '';
      const ddl = ddlKey ? String(first[ddlKey]) : JSON.stringify(first, null, 2);
      addDdlTab(`DDL - ${table}`, ddl);
    } catch (err) {
      message.error('获取DDL失败: ' + err);
    }
  };

  type TreeContextMenu =
    | { type: 'conn'; conn: DBConfig }
    | { type: 'db'; conn: DBConfig; db: string }
    | { type: 'table'; conn: DBConfig; db: string; table: TableMeta }
    | { type: 'view'; conn: DBConfig; db: string; view: ViewMeta };

  const [treeContextMenu, setTreeContextMenu] = useState<{ x: number; y: number; menu: TreeContextMenu } | null>(null);

  const openTreeContextMenu = (e: React.MouseEvent, menu: TreeContextMenu) => {
    e.preventDefault();
    e.stopPropagation();
    setTreeContextMenu({
      x: e.clientX,
      y: e.clientY,
      menu
    });
  };

  const closeTreeContextMenu = () => setTreeContextMenu(null);

  const renderConnLabel = (conn: DBConfig) => (
    <div
      className="tree-node"
      onClick={() => handleConnect(conn)}
      onDoubleClick={() => handleConnect(conn)}
      onContextMenu={(e) => openTreeContextMenu(e, { type: 'conn', conn })}
    >
      <span className={`status-dot status-${connStatus[conn.id] || 'disconnected'}`} />
      <span className="tree-label">{conn.name}</span>
    </div>
  );

  const renderDbLabel = (conn: DBConfig, db: string) => (
    <div
      className="tree-node"
      onContextMenu={(e) => openTreeContextMenu(e, { type: 'db', conn, db })}
    >
      <span className="tree-label">{db}</span>
    </div>
  );

  const renderTableLabel = (conn: DBConfig, db: string, table: TableMeta) => (
    <div
      className="tree-node tree-row"
      onContextMenu={(e) => openTreeContextMenu(e, { type: 'table', conn, db, table })}
    >
      <span className="tree-label">{table.name}</span>
    </div>
  );

  const renderViewLabel = (conn: DBConfig, db: string, view: ViewMeta) => (
    <div
      className="tree-node tree-row"
      onContextMenu={(e) => openTreeContextMenu(e, { type: 'view', conn, db, view })}
    >
      <span className="tree-label">{view.name}</span>
    </div>
  );

  const renderTreeContextMenu = () => {
    if (!treeContextMenu) return null;
    const { menu } = treeContextMenu;

    const items: { key: string; label: string; icon?: React.ReactNode; onClick: () => void }[] = [];

    if (menu.type === 'conn') {
      items.push(
        { key: 'connect', label: '连接', icon: <DatabaseOutlined />, onClick: () => handleConnect(menu.conn) },
        { key: 'sessions', label: '会话管理', icon: <DesktopOutlined />, onClick: () => openSessionTab() },
        { key: 'edit', label: '编辑', icon: <EditOutlined />, onClick: () => openEditModal(menu.conn) },
        { key: 'delete', label: '删除', icon: <DeleteOutlined />, onClick: () => handleDeleteConnection(menu.conn) }
      );
    } else if (menu.type === 'db') {
      items.push(
        { key: 'use', label: '切换到该库', icon: <DatabaseOutlined />, onClick: () => handleSelectDb(menu.conn, menu.db) },
        { key: 'refresh', label: '刷新对象', icon: <ReloadOutlined />, onClick: () => handleSelectDb(menu.conn, menu.db) },
        { key: 'export', label: '导出SQL', icon: <FileTextOutlined />, onClick: () => openExportModal(menu.conn, menu.db) }
      );
    } else if (menu.type === 'table') {
      items.push(
        {
          key: 'data',
          label: '查看数据',
          icon: <TableOutlined />,
          onClick: () => {
            if (!activeConn) return;
            addQueryTabForDb(menu.conn, menu.db, `SELECT * FROM \`${menu.table.name}\` LIMIT 200;`, `Data - ${menu.table.name}`);
          }
        },
        {
          key: 'schema',
          label: '表结构',
          icon: <FileTextOutlined />,
          onClick: () => {
            if (!activeConn) return;
            showTableDdl(menu.conn, menu.db, menu.table.name, false);
          }
        }
      );
    } else if (menu.type === 'view') {
      items.push(
        {
          key: 'data',
          label: '查看数据',
          icon: <TableOutlined />,
          onClick: () => {
            if (!activeConn) return;
            addQueryTabForDb(menu.conn, menu.db, `SELECT * FROM \`${menu.view.name}\` LIMIT 200;`, `Data - ${menu.view.name}`);
          }
        },
        {
          key: 'ddl',
          label: '表结构',
          icon: <FileTextOutlined />,
          onClick: () => {
            if (!activeConn) return;
            showTableDdl(menu.conn, menu.db, menu.view.name, true);
          }
        }
      );
    }

    return (
      <div className="tree-context-menu-mask" onClick={closeTreeContextMenu}>
        <div
          className="tree-context-menu"
          style={{ left: treeContextMenu.x, top: treeContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map(item => (
            <div
              key={item.key}
              className="tree-context-menu-item"
              onClick={() => {
                item.onClick();
                closeTreeContextMenu();
              }}
            >
              {item.icon && <span className="tree-context-menu-icon">{item.icon}</span>}
              <span className="tree-context-menu-label">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // 构造侧边栏树形菜单
  const menuItems: MenuItem[] = connections.map(conn => {
    const allDbs = dbList[conn.id] || [];
    const dbs = dbFilter
      ? allDbs.filter(name => name.toLowerCase().includes(dbFilter.toLowerCase()))
      : allDbs;
    return {
      key: conn.id,
      label: renderConnLabel(conn),
      icon: <img src={mysqlLogo} alt="MySQL" style={{ width: 16, height: 16 }} />,
      children: dbs.length > 0
        ? dbs.map(db => {
          const tables = tableList[conn.id]?.[db] || [];
          const views = viewList[conn.id]?.[db] || [];
          return {
            key: `${conn.id}-${db}`,
            label: renderDbLabel(conn, db),
            icon: <DatabaseOutlined style={{ color: '#faad14' }} />,
            children: [
              {
                key: `tables-group|${conn.id}|${db}`,
                label: 'Tables',
                icon: <TableOutlined style={{ color: '#1f6feb' }} />,
                children: tables.length > 0 ? tables.map((tableItem: TableMeta) => ({
                  key: `${conn.id}-${db}-table-${tableItem.name}`,
                  label: renderTableLabel(conn, db, tableItem),
                  icon: <TableOutlined style={{ color: '#1f6feb' }} />
                })) : [{ key: `${conn.id}-${db}-tables-empty`, label: '点击加载表', disabled: true }]
              },
              {
                key: `views-group|${conn.id}|${db}`,
                label: 'Views',
                icon: <DatabaseOutlined style={{ color: '#f97316' }} />,
                children: views.length > 0 ? views.map((viewItem: ViewMeta) => ({
                  key: `${conn.id}-${db}-view-${viewItem.name}`,
                  label: renderViewLabel(conn, db, viewItem),
                  icon: <DatabaseOutlined style={{ color: '#f97316' }} />
                })) : [{ key: `${conn.id}-${db}-views-empty`, label: '点击加载视图', disabled: true }]
              }
            ]
          };
        })
        : [{ key: `${conn.id}-load`, label: '双击连接加载库...', disabled: true }]
    };
  });

  const managerColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: 'Host', dataIndex: 'host', key: 'host' },
    { title: 'Port', dataIndex: 'port', key: 'port', width: 90 },
    { title: 'User', dataIndex: 'user', key: 'user', width: 120 },
    { title: 'DB', dataIndex: 'database', key: 'database', width: 120 },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, record: DBConfig) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteConnection(record)}>
            删除
          </Button>
        </Space>
      )
    }
  ];

  const filteredMenuItems = menuItems;

  const sessionUsers = Array.from(new Set(sessionRows.map(r => r.user).filter(Boolean)));
  const sessionDbs = Array.from(new Set(sessionRows.map(r => r.db).filter(Boolean)));

  const sessionStats = {
    total: sessionRows.length,
    active: sessionRows.filter(r => String(r.command || '').toLowerCase() !== 'sleep').length,
    lock: sessionRows.filter(r => String(r.state || '').toLowerCase().includes('lock')).length
  };

  const countBy = (key: 'user' | 'db' | 'host') => {
    const map = new Map<string, number>();
    sessionRows.forEach(r => {
      const k = r[key] || 'unknown';
      map.set(k, (map.get(k) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([k, v]) => ({ key: k, name: k, count: v }))
      .sort((a, b) => b.count - a.count);
  };

  const statsByUser = countBy('user');
  const statsByHost = countBy('host');
  const statsByDb = countBy('db');

  const filteredSessions = sessionRows.filter(r => {
    if (sessionUser && r.user !== sessionUser) return false;
    if (sessionDb && r.db !== sessionDb) return false;
    if (sessionCommand && sessionCommand !== 'active' && sessionCommand !== 'slow' && sessionCommand !== 'lock') {
      if (r.command !== sessionCommand) return false;
    }
    if (sessionCommand === 'active' && String(r.command || '').toLowerCase() === 'sleep') return false;
    if (sessionCommand === 'lock' && !String(r.state || '').toLowerCase().includes('lock')) return false;
    if (sessionSqlSearch) {
      const s = sessionSqlSearch.toLowerCase();
      const sql = String(r.info || '').toLowerCase();
      if (!sql.includes(s)) return false;
    }
    return true;
  });

  const showWorkspace = Boolean(activeConn) || queryTabs.some(tab => tab.kind === 'migration');

  return (
    <Layout className="app-shell">
      {renderTreeContextMenu()}
      {/* 顶部简单的状态栏 */}
      <Header className="app-header">
        <div className="app-title">
          <span className="brand-chip">
        <img src={mysqlLogo} alt="MySQL" className="brand-logo" />
          </span>
          <div>
            <Title level={5} style={{ margin: 0 }}>DMS Pro</Title>
            {/* subtitle removed */}
          </div>
        </div>
        <Divider type="vertical" />

        <div className="app-header-actions">
          <div className="header-toolbar">
            <Button size="small" icon={<DatabaseOutlined />} />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => activeConn && handleConnect(activeConn)} />
            <Button size="small" icon={<ConsoleSqlOutlined />} onClick={addTab} />
            <Button size="small" icon={<DesktopOutlined />} onClick={openSessionTab} />
            <Button size="small" icon={<DatabaseOutlined />} onClick={openMigrationTab} />
          </div>
        </div>
      </Header>

      <Layout>
        {/* 左侧侧边栏 */}
        <Sider width={300} theme="light" className="app-sider">
          <div className="sider-header">
            <div>
              <Text strong className="sider-title">连接管理</Text>
              <Text type="secondary" className="sider-subtitle">双击连接加载库</Text>
            </div>
            <div className="sider-actions">
              <Tooltip title="新建连接">
                <Button type="primary" shape="circle" icon={<PlusOutlined />} onClick={openCreateModal} />
              </Tooltip>
            </div>
          </div>
          <div className="sider-db-search">
            <Input
              size="small"
              allowClear
              placeholder="搜索数据库"
              value={dbFilter}
              onChange={(e) => setDbFilter(e.target.value)}
            />
          </div>
          <Menu
            mode="inline"
            inlineIndent={12}
            selectedKeys={[]}
            items={filteredMenuItems}
            className="sider-menu"
            openKeys={siderOpenKeys}
            onOpenChange={(keys) => {
              const nextKeys = keys.map(String);
              const newlyOpened = nextKeys.filter(k => !siderOpenKeys.includes(k));
              newlyOpened.forEach(keyStr => {
                const parts = keyStr.split('|');
                if (parts.length !== 3) return;
                const [group, connId, dbName] = parts;
                if (group !== 'tables-group' && group !== 'views-group') return;
                const conn = connections.find(c => c.id === connId);
                if (!conn) return;
                const tables = tableList[connId]?.[dbName] || [];
                const views = viewList[connId]?.[dbName] || [];
                if (group === 'tables-group' && tables.length === 0) {
                  loadDbObjects(conn, dbName);
                }
                if (group === 'views-group' && views.length === 0) {
                  loadDbObjects(conn, dbName);
                }
              });
              setSiderOpenKeys(nextKeys);
            }}
          />
        </Sider>

        {/* 右侧主工作区 */}
        <Content className="app-content">
          {showWorkspace ? (
            <div className="workspace" ref={workspaceRef}>
              {/* SQL 输入区 */}
              <Card
                className="sql-card"
                size="small"
                style={activeTab?.kind === 'migration'
                  ? { flex: 1, minHeight: 0 }
                  : { height: sqlPaneHeight, minHeight: 220 }}
                title={
                  <div className="sql-card-title">
                    <span>
                      {activeTab?.kind === 'ddl'
                        ? '表结构'
                        : activeTab?.kind === 'session'
                          ? '会话管理'
                          : activeTab?.kind === 'migration'
                            ? '数据库迁移'
                            : 'SQL 查询窗口'}
                    </span>
                    <span className="sql-card-conn">
                      {activeTab?.connId
                        ? `${connections.find(c => c.id === activeTab.connId)?.name || '未知连接'}:${activeTab.dbName || '未选库'}`
                        : '未选择连接'}
                    </span>
                  </div>
                }
              >
                <Tabs
                  type="editable-card"
                  activeKey={activeTabKey}
                  onChange={setActiveTabKey}
                  onEdit={(targetKey, action) => {
                    if (action === 'add') addTab();
                    if (action === 'remove' && typeof targetKey === 'string') removeTab(targetKey);
                  }}
                  items={queryTabs.map(tab => ({
                    key: tab.key,
                    label: tab.title,
                    children: tab.kind === 'ddl' ? (
                      <div className="ddl-pane">
                        <pre className="ddl-content">{tab.content || ''}</pre>
                      </div>
                    ) : tab.kind === 'session' ? (
                      <div className="session-page">
                        <div className="session-bar">
          <div className="session-left">
            <Select
              value={sessionCommand || 'all'}
              onChange={(value) => setSessionCommand(value === 'all' ? undefined : value)}
              size="small"
              options={[
                { label: `全部会话 (${sessionStats.total})`, value: 'all' },
                { label: `活跃会话 (${sessionStats.active})`, value: 'active' },
                { label: `锁等待 (${sessionStats.lock})`, value: 'lock' }
              ]}
            />
            <div className="session-pill">
              <Switch checked={sessionAuto} onChange={setSessionAuto} />
              <span>自动刷新</span>
              <InputNumber
                min={1}
                max={60}
                value={sessionInterval}
                onChange={(value) => setSessionInterval(value || 5)}
                size="small"
                controls={false}
              />
              <span>秒</span>
              <Button size="small" onClick={() => fetchSessions(activeTab?.connId)} loading={sessionLoading}>
                刷新
              </Button>
            </div>
            <div className="session-metrics">
              <span>全部会话：{sessionStats.total}</span>
              <span>活跃会话：{sessionStats.active}</span>
            </div>
          </div>
          <div className="session-right" />
        </div>

                        <div className="session-tools">
                          <div className="session-actions">
                            <Button danger onClick={killSelectedSessions}>
                              结束选中会话
                            </Button>
                          </div>
                          <div className="session-filters">
                            <Select
                              placeholder="User"
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              className="session-select"
                              value={sessionUser}
                              onChange={(value) => setSessionUser(value)}
                              options={sessionUsers.map(u => ({ label: u, value: u }))}
                            />
                            <Select
                              placeholder="DB"
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              className="session-select"
                              value={sessionDb}
                              onChange={(value) => setSessionDb(value)}
                              options={sessionDbs.map(d => ({ label: d, value: d }))}
                            />
                            <Input
                              placeholder="SQL 搜索"
                              value={sessionSqlSearch}
                              onChange={(e) => setSessionSqlSearch(e.target.value)}
                              allowClear
                            />
                          </div>
                        </div>

                        <Table
                          rowKey="id"
                          size="small"
                          loading={sessionLoading}
                          dataSource={filteredSessions}
                          pagination={{ pageSize: 10, showSizeChanger: false }}
                          rowSelection={{
                            selectedRowKeys: selectedSessionIds,
                            onChange: (keys) => setSelectedSessionIds(keys as number[])
                          }}
                          rowClassName={(record: any) => {
                            const state = String(record.state || '').toLowerCase();
                            if (state.includes('lock')) return 'session-row-lock';
                            return '';
                          }}
                          columns={[
                            { title: 'ID', dataIndex: 'id', key: 'id', width: 140 },
                            { title: 'User', dataIndex: 'user', key: 'user', width: 140 },
                            { title: 'Host', dataIndex: 'host', key: 'host', width: 220, ellipsis: true },
                            {
                              title: 'DB',
                              dataIndex: 'db',
                              key: 'db',
                              width: 160,
                              ellipsis: true,
                              render: (text: string) => (
                                <Tooltip title={text}>
                                  <span className="stats-ellipsis">{text}</span>
                                </Tooltip>
                              )
                            },
                            { title: 'Command', dataIndex: 'command', key: 'command', width: 120 },
                            { title: 'Time', dataIndex: 'time', key: 'time', width: 90, sorter: (a: any, b: any) => Number(a.time || 0) - Number(b.time || 0) },
                            { title: 'State', dataIndex: 'state', key: 'state', width: 160, ellipsis: true },
                            { title: 'SQL', dataIndex: 'info', key: 'info', ellipsis: true, render: (text: any) => text || '' }
                          ]}
                        />
                          <div className="session-stats">
                          <div className="stats-table">
                            <div className="stats-title">按用户统计</div>
                            <Table
                              size="small"
                              pagination={{ pageSize: 10, showSizeChanger: false }}
                              rowKey="name"
                              dataSource={statsByUser}
                              columns={[
                                { title: '用户', dataIndex: 'name', key: 'name' },
                                { title: '会话数', dataIndex: 'count', key: 'count', width: 80 }
                              ]}
                            />
                          </div>
                          <div className="stats-table">
                            <div className="stats-title">按来源统计</div>
                            <Table
                              size="small"
                              pagination={{ pageSize: 10, showSizeChanger: false }}
                              rowKey="name"
                              dataSource={statsByHost}
                              columns={[
                                {
                                  title: '来源',
                                  dataIndex: 'name',
                                  key: 'name',
                                  width: 200,
                                  ellipsis: true,
                                  render: (text: string) => (
                                    <Tooltip title={text}>
                                      <span className="stats-ellipsis">{text}</span>
                                    </Tooltip>
                                  )
                                },
                                { title: '会话数', dataIndex: 'count', key: 'count', width: 80 }
                              ]}
                            />
                          </div>
                          <div className="stats-table">
                            <div className="stats-title">按数据库统计</div>
                            <Table
                              size="small"
                              pagination={{ pageSize: 10, showSizeChanger: false }}
                              rowKey="name"
                              dataSource={statsByDb}
                              columns={[
                                { title: 'DB', dataIndex: 'name', key: 'name' },
                                { title: '会话数', dataIndex: 'count', key: 'count', width: 80 }
                              ]}
                            />
                          </div>
                        </div>
                      </div>
                    ) : tab.kind === 'migration' ? (
                      <div className="migration-page">
                        <div className="migration-mode">
                          <div className="migration-section-title">迁移模式</div>
                          <Radio.Group
                            value={migrationMode}
                            onChange={(e) => {
                              setMigrationMode(e.target.value);
                              setMigrationCheck([]);
                            }}
                            options={[
                              { label: '仅结构', value: 'schema' },
                              { label: '结构 + 数据', value: 'both' },
                              { label: '仅数据', value: 'data' }
                            ]}
                            optionType="button"
                            buttonStyle="solid"
                          />
                        </div>
                        <div className="migration-grid">
                          <div className="migration-card">
                            <div className="migration-title">源实例</div>
                            <Select
                              placeholder="选择源连接"
                              value={migrationSourceConn || undefined}
                              onChange={async (value) => {
                                setMigrationSourceConn(value);
                                setMigrationSourceDb('');
                                setMigrationSourceTables([]);
                                setMigrationCheck([]);
                                await loadMigrationSourceTree(value);
                              }}
                              options={connections.map(c => ({ label: c.name, value: c.id }))}
                            />
                          </div>
                          <div className="migration-card">
                            <div className="migration-title">目标实例</div>
                            <Select
                              placeholder="选择目标连接"
                              value={migrationTargetConn || undefined}
                              onChange={async (value) => {
                                setMigrationTargetConn(value);
                                setMigrationTargetDb('');
                                setMigrationCheck([]);
                                const list = await loadDbListFor(value, 'target');
                                const firstDb = list && list.length > 0 ? list[0] : '';
                                setMigrationTargetDb(firstDb);
                              }}
                              options={connections.map(c => ({ label: c.name, value: c.id }))}
                            />
                          </div>
                        </div>

                        <div className="migration-selection">
                          <div className="migration-section-title">迁移库选择</div>
                          <div className="migration-selection-row">
                            <div className="migration-selection-item">
                              <div className="migration-selection-label">源库</div>
                              <Select
                                placeholder="选择源库"
                                value={migrationSourceDb || undefined}
                                onChange={async (value) => {
                                  setMigrationSourceDb(value);
                                  setMigrationSourceTables([]);
                                  setMigrationCheck([]);
                                  await loadMigrationSourceTables(migrationSourceConn || '', value);
                                }}
                                showSearch
                                optionFilterProp="label"
                                options={(migrationSources[migrationSourceConn] || []).map(d => ({ label: d, value: d }))}
                              />
                            </div>
                            <div className="migration-selection-item">
                              <div className="migration-selection-label">源库表选择</div>
                              <Select
                                mode="multiple"
                                placeholder="选择表（可多选）"
                                value={migrationSourceTables}
                                onChange={(value) => {
                                  setMigrationSourceTables(value);
                                  setMigrationCheck([]);
                                }}
                                showSearch
                                optionFilterProp="label"
                                maxTagCount={3}
                                maxTagTextLength={20}
                                maxTagPlaceholder={(omitted) => `+${omitted.length} 个`}
                                options={(tableList[migrationSourceConn]?.[migrationSourceDb] || []).map(t => ({
                                  label: t.name,
                                  value: t.name
                                }))}
                              />
                              <div className="migration-selection-actions">
                                <Button
                                  size="small"
                                  onClick={() => {
                                    const all = (tableList[migrationSourceConn]?.[migrationSourceDb] || []).map(t => t.name);
                                    setMigrationSourceTables(all);
                                    setMigrationCheck([]);
                                  }}
                                >
                                  全选
                                </Button>
                                <Button size="small" onClick={() => {
                                  setMigrationSourceTables([]);
                                  setMigrationCheck([]);
                                }}>
                                  清空
                                </Button>
                              </div>
                            </div>
                            <div className="migration-selection-item">
                              <div className="migration-selection-label">目标库</div>
                              <Select
                                placeholder="选择目标库"
                                value={migrationTargetDb || undefined}
                                onChange={(value) => {
                                  setMigrationTargetDb(value);
                                  setMigrationCheck([]);
                                }}
                                showSearch
                                optionFilterProp="label"
                                options={(migrationTargets[migrationTargetConn] || []).map(d => ({ label: d, value: d }))}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="migration-actions">
                          <Space>
                            <Button onClick={runMigrationCheck} loading={migrationLoading}>
                              预检查
                            </Button>
                            <Button type="primary" onClick={runMigration} loading={migrationLoading}>
                              开始同步
                            </Button>
                          </Space>
                        </div>

                        <div className="migration-result">
                          <div className="migration-section-title">预检查结果</div>
                          <Table
                            size="small"
                            rowKey="name"
                            loading={migrationLoading}
                            dataSource={migrationCheck}
                            pagination={{ pageSize: 10, showSizeChanger: false }}
                            columns={[
                              { title: '表名', dataIndex: 'name', key: 'name' },
                              { title: '源行数', dataIndex: 'sourceRows', key: 'sourceRows', width: 100 },
                              { title: '目标行数', dataIndex: 'targetRows', key: 'targetRows', width: 100 },
                              { title: '状态', dataIndex: 'status', key: 'status', width: 200 }
                            ]}
                          />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="sql-editor-row">
                          <div className="sql-editor-actions">
                            <Tooltip title="执行选中 SQL（未选中则执行全部）">
                              <Button
                                type="primary"
                                shape="circle"
                                icon={<CaretRightOutlined />}
                                onClick={() => runSelectedSql(tab.key)}
                                loading={tab.loading}
                              />
                            </Tooltip>
                            <Tooltip title="执行全部 SQL">
                              <Button
                                shape="circle"
                                icon={<ThunderboltOutlined />}
                                onClick={() => executeTabSql(tab.key)}
                                loading={tab.loading}
                              />
                            </Tooltip>
                          </div>
                          <div className="sql-editor-wrapper">
                            <Editor
                              height="100%"
                              language="sql"
                              value={tab.sql}
                            onChange={value => updateTab(tab.key, { sql: value || '' })}
                            onMount={(editor, monaco) => {
                              editorRef.current = editor;
                              monacoRef.current = monaco;
                              if (!completionRegistered.current) {
                                completionRegistered.current = true;
                                monaco.languages.registerCompletionItemProvider('sql', {
                                  triggerCharacters: ['.', ' '],
                                  provideCompletionItems: (model, position) => {
                                    const line = model.getLineContent(position.lineNumber);
                                    const prefix = line.slice(0, position.column - 1);
                                    const tableMatch = prefix.match(/`?([a-zA-Z0-9_]+)`?\.$/);
                                    if (tableMatch) {
                                      const upToCursor = model.getValue().slice(0, model.getOffsetAt(position));
                                      const aliasMap = parseAliasMap(upToCursor);
                                      const tableName = aliasMap[tableMatch[1]] || tableMatch[1];
                                      const range = new monaco.Range(
                                        position.lineNumber,
                                        position.column,
                                        position.lineNumber,
                                        position.column
                                      );
                                      const cols = suggestionRef.current.columns
                                        .filter(col => col.table === tableName)
                                        .map(col => ({
                                          label: col.column,
                                          kind: monaco.languages.CompletionItemKind.Field,
                                          insertText: `\`${col.column}\``,
                                          range,
                                          detail: tableName
                                        }));
                                      return { suggestions: cols };
                                    }
                                    const range = new monaco.Range(
                                      position.lineNumber,
                                      position.column - 1,
                                      position.lineNumber,
                                      position.column
                                    );
                                    const tables = suggestionRef.current.tables.map(name => ({
                                      label: name,
                                      kind: monaco.languages.CompletionItemKind.Class,
                                      insertText: `\`${name}\``,
                                      range
                                    }));
                                    const columns = suggestionRef.current.columns.map(col => ({
                                      label: `${col.table}.${col.column}`,
                                      kind: monaco.languages.CompletionItemKind.Field,
                                      insertText: `\`${col.column}\``,
                                      range,
                                      detail: col.table
                                    }));
                                    return { suggestions: [...tables, ...columns] };
                                  }
                                });
                              }
                            }}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13,
                              fontFamily: '"JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, monospace',
                              lineNumbers: 'off',
                              scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
                              overviewRulerBorder: false,
                              scrollBeyondLastLine: false,
                              wordWrap: 'on'
                            }}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  }))}
                />
              </Card>

              {/* 拖拽分隔条 */}
              {activeTab?.kind !== 'ddl' && activeTab?.kind !== 'session' && activeTab?.kind !== 'migration' && (activeTab?.results || []).length > 0 && (
                <div
                  className="sql-resizer"
                  onMouseDown={() => {
                    isResizingRef.current = true;
                  }}
                />
              )}

              {/* 结果展示区 */}
              {activeTab?.kind !== 'ddl' && activeTab?.kind !== 'session' && activeTab?.kind !== 'migration' && (activeTab?.results || []).length > 0 && (
                <Card
                  className="result-card"
                  size="small"
                  bodyStyle={{ padding: 0, height: '100%', overflow: 'hidden' }}
                >
                  <Tabs
                    type="editable-card"
                    activeKey={activeTab?.activeResultKey}
                    onChange={(key) => updateActiveTab({ activeResultKey: key })}
                    className="result-tabs"
                    hideAdd
                    onEdit={(targetKey, action) => {
                      if (action !== 'remove') return;
                      if (!activeTab) return;
                      const results = activeTab.results || [];
                      const nextResults = results.filter(r => r.key !== targetKey);
                      let nextActive = activeTab.activeResultKey;
                      if (nextActive === targetKey) {
                        nextActive = nextResults.length ? nextResults[nextResults.length - 1].key : undefined;
                      }
                      updateActiveTab({ results: nextResults, activeResultKey: nextActive });
                    }}
                    renderTabBar={(props, DefaultTabBar) => (
                      <div className="result-tabs-bar">
                        <DefaultTabBar {...props} />
                        <div className="result-tabs-actions">
                          <Space>
                            {typeof (activeTab?.results || []).find(r => r.key === activeTab?.activeResultKey)?.durationMs === 'number' && (
                              <Text type="secondary">
                                耗时 {(activeTab?.results || []).find(r => r.key === activeTab?.activeResultKey)?.durationMs} ms
                              </Text>
                            )}
                            <Button size="small" onClick={() => exportResultToExcel(activeTab?.activeResultKey || '')}>
                              导出 Excel
                            </Button>
                          </Space>
                        </div>
                      </div>
                    )}
                    items={(activeTab?.results || []).map(result => ({
                      key: result.key,
                      label: result.title,
                      children: (
                        <div className="result-table-wrap">
                          <Table
                            dataSource={result.data || []}
                            columns={(result.columns || []).map((col: any) => {
                              const width = col.width || 220;
                              if (col.render) {
                                return { ...col, ellipsis: true, width };
                              }
                              return {
                                ...col,
                                ellipsis: true,
                                width,
                                render: (value: any) => {
                                  const text = truncateCellText(value, 80);
                                  return (
                                    <span
                                      title="双击复制完整内容"
                                      className="result-cell"
                                      onDoubleClick={() => copyCellText(value)}
                                    >
                                      {text}
                                    </span>
                                  );
                                }
                              };
                            })}
                            size="small"
                            bordered
                            sticky
                            rowKey={(record, index) => record?.id ?? record?._id ?? index ?? Math.random()}
                            pagination={{ defaultPageSize: 10, showSizeChanger: true }}
                            scroll={{ x: 'max-content' }}
                            tableLayout="fixed"
                          />
                        </div>
                      )
                    }))}
                  />
                </Card>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-card">
                <DesktopOutlined className="empty-icon" />
                <Title level={4} type="secondary">请在左侧双击连接以开始工作</Title>
                <Text type="secondary">像 Navicat 一样快速管理连接、数据库与查询</Text>
              </div>
            </div>
          )}
        </Content>
      </Layout>

      {/* 连接管理弹窗 */}
      <Modal
        title="连接管理"
        open={isManagerOpen}
        onCancel={() => setIsManagerOpen(false)}
        footer={null}
        width={720}
      >
        <Table
          rowKey="id"
          dataSource={connections}
          columns={managerColumns}
          size="small"
          pagination={false}
        />
      </Modal>

      {/* 导出SQL弹窗 */}
      <Modal
        title={`导出SQL${exportDb ? ` - ${exportDb.db}` : ''}`}
        open={isExportOpen}
        onCancel={() => setIsExportOpen(false)}
        onOk={handleExportSql}
        okText="导出"
        cancelText="取消"
        width={520}
        maskClosable={false}
        keyboard={false}
      >
        <div className="export-tip">请选择要导出的表：</div>
        <div className="export-mode">
          <Text type="secondary">导出内容：</Text>
          <Space>
            <Button size="small" type={exportMode === 'schema' ? 'primary' : 'default'} onClick={() => setExportMode('schema')}>
              结构
            </Button>
            <Button size="small" type={exportMode === 'data' ? 'primary' : 'default'} onClick={() => setExportMode('data')}>
              数据
            </Button>
            <Button size="small" type={exportMode === 'both' ? 'primary' : 'default'} onClick={() => setExportMode('both')}>
              结构+数据
            </Button>
          </Space>
        </div>
        <div className="export-mysqldump">
          <Text type="secondary">mysqldump 路径（可选）：</Text>
          <Input
            placeholder="留空自动查找，如 /usr/local/bin/mysqldump"
            value={appSettings.mysqldumpPath}
            onChange={(e) => setAppSettings(prev => ({ ...prev, mysqldumpPath: e.target.value }))}
            allowClear
          />
        </div>
        <Input
          placeholder="搜索表名..."
          value={exportSearch}
          onChange={(e) => setExportSearch(e.target.value)}
          allowClear
        />
        <div className="export-actions">
          <Button size="small" onClick={() => setExportTables((tableList[exportDb?.conn.id || '']?.[exportDb?.db || ''] || []).map(t => t.name))}>
            全选
          </Button>
          <Button size="small" onClick={() => setExportTables([])}>
            清空
          </Button>
        </div>
        <div className="export-list">
          {(tableList[exportDb?.conn.id || '']?.[exportDb?.db || ''] || [])
            .filter(t => t.name.toLowerCase().includes(exportSearch.toLowerCase()))
            .map(t => (
            <label key={t.name} className="export-item">
              <input
                type="checkbox"
                checked={exportTables.includes(t.name)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setExportTables(prev => [...prev, t.name]);
                  } else {
                    setExportTables(prev => prev.filter(n => n !== t.name));
                  }
                }}
              />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
        <div className="export-log-title">导出日志</div>
        <div className="export-log" ref={exportLogRef}>
          {exportLogs.length === 0 ? (
            <div className="export-log-empty">等待开始导出...</div>
          ) : (
            exportLogs.map((line, idx) => (
              <div key={`${line}-${idx}`} className="export-log-line">{line}</div>
            ))
          )}
        </div>
      </Modal>

      {/* 新建/编辑连接对话框 */}
      <Modal
        title={editingConn ? '编辑数据库连接' : '创建新数据库连接'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingConn(null);
        }}
        onOk={() => form.submit()}
        okText={editingConn ? '保存修改' : '保存并关闭'}
        cancelText="取消"
        footer={[
          <Button key="cancel" onClick={() => {
            setIsModalOpen(false);
            setEditingConn(null);
          }}>
            取消
          </Button>,
          <Button key="test" onClick={handleTestConnection}>
            测试连接
          </Button>,
          <Button key="submit" type="primary" onClick={() => form.submit()}>
            {editingConn ? '保存修改' : '保存并关闭'}
          </Button>
        ]}
      >
        <Form form={form} layout="vertical" onFinish={handleSaveConnection}>
          <Form.Item name="name" label="连接名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如: 本地测试环境" />
          </Form.Item>
          <Form.Item name="host" label="Host" rules={[{ required: true, message: '请输入主机地址' }]}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item name="port" label="Port" rules={[{ required: true, message: '请输入端口' }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="3306" />
          </Form.Item>
          <Form.Item name="user" label="User" rules={[{ required: true, message: '请输入用户名' }] }>
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name="password" label="Password">
            <Input.Password placeholder="密码(可选)" />
          </Form.Item>
          <Form.Item name="database" label="Database">
            <Input placeholder="默认数据库(可选)" />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            连接信息将以 Host/Port/User 形式保存，启动后可直接复用。
          </Text>
        </Form>
      </Modal>
    </Layout>
  );
};

export default App;
