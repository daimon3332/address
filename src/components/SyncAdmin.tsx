import { useCallback, useEffect, useState, type SubmitEventHandler } from 'react';
import { countries } from '../domain/countries';

type SyncStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface SyncJob {
  id: string;
  trigger: 'manual' | 'scheduled';
  status: SyncStatus;
  phase?: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  releaseId: string | null;
  shards?: string[];
  error: string | null;
}

interface ApiResult {
  accepted?: boolean;
  job?: SyncJob;
  error?: string;
}

const statusLabel: Record<SyncStatus, string> = {
  queued: '等待执行',
  running: '同步中',
  succeeded: '已完成',
  failed: '失败'
};

const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';

export default function SyncAdmin({ apiBase }: { apiBase: string }) {
  const [token, setToken] = useState('');
  const [job, setJob] = useState<SyncJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [shard, setShard] = useState('all');
  const [error, setError] = useState('');
  const base = apiBase.replace(/\/$/u, '');

  const request = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    if (!token.trim()) throw new Error('请输入管理令牌');
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit'
    });
    const data = await response.json() as ApiResult;
    if (!response.ok && response.status !== 409) {
      throw new Error(data.error === 'UNAUTHORIZED' ? '管理令牌不正确' : (data.error || `请求失败 (${response.status})`));
    }
    return data;
  }, [base, token]);

  const refresh = useCallback(async (id?: string) => {
    setError('');
    const data = await request(id ? `/api/v1/sync/jobs/${id}` : '/api/v1/sync/jobs/latest');
    if (data.job) setJob(data.job);
  }, [request]);

  const submit: SubmitEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await request('/api/v1/sync/jobs', 'POST', { shards: [shard] });
      if (data.job) setJob(data.job);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status) || !token.trim()) return;
    const timer = window.setInterval(() => void refresh(job.id).catch((requestError) => {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }), 2000);
    return () => window.clearInterval(timer);
  }, [job, refresh, token]);

  return (
    <main className="sync-admin">
      <header className="sync-header">
        <div>
          <p>数据管理</p>
          <h1>地址热池同步</h1>
        </div>
        <a href="/zh-CN/">返回生成器</a>
      </header>

      <form className="sync-controls" onSubmit={submit}>
        <label>
          <span>管理令牌</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label>
          <span>同步分片</span>
          <select value={shard} onChange={(event) => setShard(event.target.value)}>
            <option value="all">所有国家（强制重同步）</option>
            {countries.map((country) => <option key={country.code} value={country.code}>{country.name['zh-CN']} ({country.code})</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || !token.trim() || Boolean(job && ['queued', 'running'].includes(job.status))}>
          {busy ? '正在提交' : '同步所选'}
        </button>
        <button type="button" className="secondary" disabled={busy || !token.trim()} onClick={() => {
          setBusy(true);
          void refresh(job?.id).catch((requestError) => {
            setError(requestError instanceof Error ? requestError.message : String(requestError));
          }).finally(() => setBusy(false));
        }}>
          刷新状态
        </button>
      </form>

      {error && <p className="sync-error" role="alert">{error}</p>}

      <section className="sync-status" aria-live="polite">
        <div className="sync-status-heading">
          <h2>最近任务</h2>
          {job && <span className={`status-${job.status}`}>{statusLabel[job.status]}</span>}
        </div>
        {job ? (
          <dl>
            <div><dt>任务 ID</dt><dd>{job.id}</dd></div>
            <div><dt>触发方式</dt><dd>{job.trigger === 'manual' ? '手动' : '自动计划'}</dd></div>
            <div><dt>同步分片</dt><dd>{job.shards?.join(', ') || 'all'}</dd></div>
            <div><dt>当前阶段</dt><dd>{job.phase || '-'}</dd></div>
            <div><dt>创建时间</dt><dd>{dateTime(job.createdAt)}</dd></div>
            <div><dt>开始时间</dt><dd>{dateTime(job.startedAt)}</dd></div>
            <div><dt>完成时间</dt><dd>{dateTime(job.completedAt)}</dd></div>
            <div><dt>Release</dt><dd>{job.releaseId || '-'}</dd></div>
            {job.error && <div className="error-row"><dt>错误</dt><dd>{job.error}</dd></div>}
          </dl>
        ) : <p className="empty-status">暂无已加载的同步任务</p>}
      </section>
    </main>
  );
}
