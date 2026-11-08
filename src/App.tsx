import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  client, errorMessage, formatDate, getActions, roleLabels, statusLabels,
} from './crm';
import type { Profile, Site, Status, Task, TaskAction, TaskEvent } from './crm';

type Screen = { type: 'sites' | 'mine' } | { type: 'site' | 'task'; id: string };
type Editor =
  | { type: 'site'; site?: Site }
  | { type: 'task'; siteId: string; task?: Task };
type Confirm = { title: string; label: string; submit: (note: string) => Promise<void>; action?: TaskAction };

function Alert({ children }: { children: ReactNode }) {
  return <p className="alert" role="alert">{children}</p>;
}

export function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return;
    let current = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (current) setSession(nextSession);
    });
    void client.auth.getSession().then(({ error: authError }) => {
      if (current && authError) setError(errorMessage(authError));
    });
    return () => {
      current = false;
      subscription.unsubscribe();
    };
  }, []);

  if (!client) {
    return <main className="login"><Alert>Подключение к Supabase не настроено. Проверьте переменные окружения по README.</Alert></main>;
  }
  if (session === undefined) return <main className="login">{error ? <Alert>{error}</Alert> : <p role="status">Загрузка…</p>}</main>;
  if (!session) return <SignIn />;
  return <Workspace key={session.user.id} userId={session.user.id} />;
}

function SignIn() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const { error: authError } = await client!.auth.signInWithPassword({
        email: String(data.get('email')).trim(),
        password: String(data.get('password')),
      });
      if (authError) {
        setError(authError.code === 'invalid_credentials' ? 'Проверьте email и пароль.' : errorMessage(authError));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="panel">
        <p className="eyebrow">Строительная компания</p>
        <h1>Объекты и задачи</h1>
        <p className="muted">Войдите под выданной вам учётной записью.</p>
        <form onSubmit={signIn}>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <Alert>{error}</Alert>}
          <button className="primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        </form>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${status}`}>{statusLabels[status]}</span>;
}

function Workspace({ userId }: { userId: string }) {
  const [screen, setScreen] = useState<Screen>({ type: 'sites' });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [history, setHistory] = useState<TaskEvent[]>([]);

  const refresh = useCallback(async () => {
    const db = client!;
    const [profileResult, siteResult, taskResult, historyResult] = await Promise.all([
      db.from('profiles').select('id,name,role').order('name'),
      db.from('sites').select('id,name,address').order('name'),
      db.from('tasks').select('id,site_id,title,description,assignee_id,author_id,created_at,status').order('created_at', { ascending: false }),
      db.from('task_history').select('id,task_id,actor_id,happened_at,from_status,to_status,comment').order('id'),
    ]);
    const failure = profileResult.error ?? siteResult.error ?? taskResult.error ?? historyResult.error;
    if (failure) throw failure;
    setProfiles(profileResult.data ?? []);
    setSites(siteResult.data ?? []);
    setTasks(taskResult.data ?? []);
    setHistory(historyResult.data ?? []);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause))).finally(() => setLoading(false));
  }, [refresh]);

  const profile = profiles.find((item) => item.id === userId);
  const isManager = profile?.role === 'manager';
  const activeTask = screen.type === 'task' ? tasks.find((task) => task.id === screen.id) : undefined;
  const siteId = screen.type === 'site' ? screen.id : activeTask?.site_id;
  const activeSite = sites.find((site) => site.id === siteId);
  const nameOf = (id: string) => profiles.find((item) => item.id === id)?.name ?? 'Пользователь';

  function navigate(next: Screen) {
    setEditor(null);
    setConfirm(null);
    setActionError('');
    setScreen(next);
  }

  function edit(next: Editor) {
    setActionError('');
    setConfirm(null);
    setEditor(next);
  }

  function ask(next: Confirm) {
    setActionError('');
    setEditor(null);
    setConfirm(next);
  }

  async function mutate(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    setError('');
    try {
      await action();
    } catch (cause) {
      setActionError(errorMessage(cause));
      setBusy(false);
      return;
    }
    setEditor(null);
    setConfirm(null);
    try {
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!editor) return;
    await mutate(async () => {
      if (editor.type === 'site') {
        const fields = { name: String(data.get('name')).trim(), address: String(data.get('address')).trim() };
        const result = editor.site
          ? await client!.from('sites').update(fields).eq('id', editor.site.id).select('id').single()
          : await client!.from('sites').insert(fields).select('id').single();
        if (result.error) throw result.error;
        setScreen({ type: 'site', id: result.data.id });
      } else {
        const fields = {
          title: String(data.get('title')).trim(),
          description: String(data.get('description')).trim(),
          assignee_id: String(data.get('assignee')),
          site_id: String(data.get('site')),
        };
        const result = editor.task
          ? await client!.from('tasks').update(fields).eq('id', editor.task.id).select('id').single()
          : await client!.from('tasks').insert(fields).select('id').single();
        if (result.error) throw result.error;
        setScreen({ type: 'task', id: result.data.id });
      }
    });
  }

  function archive(type: 'site' | 'task', id: string) {
    const isSite = type === 'site';
    ask({
      title: isSite ? 'Удалить объект и скрыть его задачи?' : 'Удалить задачу?',
      label: 'Удалить',
      async submit() {
        const result = isSite
          ? await client!.rpc('archive_site', { site_id: id })
          : await client!.rpc('archive_task', { task_id: id });
        if (result.error) throw result.error;
        setScreen(!isSite && activeSite ? { type: 'site', id: activeSite.id } : { type: 'sites' });
      },
    });
  }

  function transition(task: Task, action: TaskAction) {
    ask({
      title: `${action.label}?`,
      label: action.label,
      action,
      async submit(note) {
        const { error: transitionError } = await client!.rpc('transition_task', {
          task_id: task.id, next_status: action.status, note: note.trim() || null,
        });
        if (transitionError) throw transitionError;
      },
    });
  }

  function taskList(items: Task[], showSite: boolean) {
    if (!items.length) return <p className="empty">Задач пока нет.</p>;
    return (
      <ul className="list">
        {items.map((task) => (
          <li key={task.id} className="row">
            <div>
              <button className="link" onClick={() => navigate({ type: 'task', id: task.id })}>{task.title}</button>
              <p className="muted">{showSite ? sites.find((site) => site.id === task.site_id)?.name : nameOf(task.assignee_id)}</p>
            </div>
            <StatusBadge status={task.status} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <header>
        <div className="header-inner">
          <button className="brand" onClick={() => navigate({ type: 'sites' })}>Объекты и задачи</button>
          <div className="account">
            {profile && <span>{profile.name} · {roleLabels[profile.role]}</span>}
            <button disabled={busy} onClick={async () => {
              const result = await client!.auth.signOut();
              if (result.error) setError(errorMessage(result.error));
            }}>Выйти</button>
          </div>
        </div>
      </header>
      <main className="workspace">
        <nav aria-label="Разделы">
          <button aria-current={screen.type === 'sites' || screen.type === 'site' ? 'page' : undefined} onClick={() => navigate({ type: 'sites' })}>Объекты</button>
          {profile?.role === 'worker' && <button aria-current={screen.type === 'mine' ? 'page' : undefined} onClick={() => navigate({ type: 'mine' })}>Мои задачи</button>}
        </nav>
        {error && <Alert>{error}</Alert>}
        {loading ? <p role="status">Загрузка…</p> : !profile ? (
          !error && <Alert>Для аккаунта не назначена роль. Обратитесь к администратору.</Alert>
        ) : (
          <>
            {screen.type === 'sites' && (
              <section className="panel">
                <div className="section-head">
                  <h1>Объекты</h1>
                  {isManager && <button className="primary" onClick={() => edit({ type: 'site' })}>Новый объект</button>}
                </div>
                {!sites.length && <p className="empty">Доступных объектов пока нет.</p>}
                <ul className="list">
                  {sites.map((site) => (
                    <li key={site.id} className="row">
                      <div>
                        <button className="link" onClick={() => navigate({ type: 'site', id: site.id })}>{site.name}</button>
                        <p className="muted">{site.address}</p>
                      </div>
                      <span className="count">Задач: {tasks.filter((task) => task.site_id === site.id).length}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {screen.type === 'mine' && <section className="panel"><h1>Мои задачи</h1>{taskList(tasks, true)}</section>}
            {screen.type === 'site' && (activeSite ? (
              <section className="panel">
                <div className="section-head">
                  <div><h1>{activeSite.name}</h1><p className="muted">{activeSite.address}</p></div>
                  {isManager && (
                    <div className="actions">
                      <button onClick={() => edit({ type: 'site', site: activeSite })}>Редактировать</button>
                      <button className="danger" onClick={() => archive('site', activeSite.id)}>Удалить</button>
                    </div>
                  )}
                </div>
                <div className="section-head">
                  <h2>Задачи объекта</h2>
                  {isManager && <button className="primary" onClick={() => edit({ type: 'task', siteId: activeSite.id })}>Новая задача</button>}
                </div>
                {taskList(tasks.filter((task) => task.site_id === activeSite.id), false)}
              </section>
            ) : <Alert>Объект недоступен.</Alert>)}
            {screen.type === 'task' && (activeTask ? (
              <section className="panel">
                {activeSite && <button className="link back" onClick={() => navigate({ type: 'site', id: activeSite.id })}>← {activeSite.name}</button>}
                <div className="section-head">
                  <h1>{activeTask.title}</h1><StatusBadge status={activeTask.status} />
                </div>
                <p className="description">{activeTask.description || 'Описание не добавлено.'}</p>
                <dl>
                  <div><dt>Исполнитель</dt><dd>{nameOf(activeTask.assignee_id)}</dd></div>
                  <div><dt>Постановщик</dt><dd>{nameOf(activeTask.author_id)}</dd></div>
                  <div><dt>Создана</dt><dd>{formatDate(activeTask.created_at)}</dd></div>
                </dl>
                <div className="actions">
                  {getActions(activeTask, profile).map((action) => <button className="primary" key={action.status} onClick={() => transition(activeTask, action)}>{action.label}</button>)}
                  {isManager && <>
                    <button onClick={() => edit({ type: 'task', task: activeTask, siteId: activeTask.site_id })}>Редактировать</button>
                    <button className="danger" onClick={() => archive('task', activeTask.id)}>Удалить</button>
                  </>}
                </div>
                <h2>История</h2>
                <ol className="history">
                  {history.filter((entry) => entry.task_id === activeTask.id).map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.from_status ? statusLabels[entry.from_status] + ' → ' : 'Создание → '}{statusLabels[entry.to_status]}</strong>
                      <div className="muted">{nameOf(entry.actor_id)} · {formatDate(entry.happened_at)}</div>
                      {entry.comment && <p className="description">{entry.comment}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            ) : <Alert>Задача недоступна.</Alert>)}
          </>
        )}
        {editor && (
          <section className="panel dialog" aria-labelledby="editor-title">
            <h2 id="editor-title">{editor.type === 'site' ? (editor.site ? 'Редактировать объект' : 'Новый объект') : (editor.task ? 'Редактировать задачу' : 'Новая задача')}</h2>
            <form key={editor.type + (editor.type === 'site' ? editor.site?.id : editor.task?.id)} onSubmit={save}>
              {editor.type === 'site' ? (
                <>
                  <label>Название<input name="name" defaultValue={editor.site?.name} required maxLength={150} /></label>
                  <label>Адрес<input name="address" defaultValue={editor.site?.address} required maxLength={300} /></label>
                </>
              ) : (
                <>
                  <label>Название<input name="title" defaultValue={editor.task?.title} required maxLength={150} /></label>
                  <label>Описание<textarea name="description" defaultValue={editor.task?.description} maxLength={5000} rows={4} /></label>
                  <label>Объект<select name="site" defaultValue={editor.siteId} required>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
                  <label>Исполнитель<select name="assignee" defaultValue={editor.task?.assignee_id ?? ''} required>
                    <option value="" disabled>Выберите исполнителя</option>
                    {profiles.filter((item) => item.role === 'worker').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select></label>
                </>
              )}
              {actionError && <Alert>{actionError}</Alert>}
              <div className="actions">
                <button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
                <button type="button" disabled={busy} onClick={() => setEditor(null)}>Отмена</button>
              </div>
            </form>
          </section>
        )}
        {confirm && (
          <section className="panel dialog" aria-labelledby="confirm-title">
            <h2 id="confirm-title">{confirm.title}</h2>
            <form key={confirm.title} onSubmit={(event) => {
              event.preventDefault();
              const note = String(new FormData(event.currentTarget).get('note') ?? '');
              void mutate(() => confirm.submit(note));
            }}>
              {confirm.action && <label>
                {confirm.action.status === 'revision' ? 'Причина возврата' : 'Комментарий (необязательно)'}
                <textarea name="note" required={confirm.action.status === 'revision'} maxLength={2000} rows={3} />
              </label>}
              {actionError && <Alert>{actionError}</Alert>}
              <div className="actions">
                <button className={confirm.action ? 'primary' : 'danger'} disabled={busy}>{busy ? 'Сохраняем…' : confirm.label}</button>
                <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Отмена</button>
              </div>
            </form>
          </section>
        )}
      </main>
    </>
  );
}
