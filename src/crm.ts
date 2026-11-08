import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const client = url && key ? createClient(url, key) : null;

export type Role = 'manager' | 'worker';
export type Status = 'new' | 'in_progress' | 'review' | 'accepted' | 'revision';
export type Profile = { id: string; name: string; role: Role };
export type Site = { id: string; name: string; address: string };
export type Task = {
  id: string;
  site_id: string;
  title: string;
  description: string;
  assignee_id: string;
  author_id: string;
  created_at: string;
  status: Status;
};
export type TaskEvent = {
  id: number;
  task_id: string;
  actor_id: string;
  happened_at: string;
  from_status: Status | null;
  to_status: Status;
  comment: string | null;
};

export const statusLabels: Record<Status, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  accepted: 'Принята',
  revision: 'На доработке',
};

export const roleLabels: Record<Role, string> = {
  manager: 'Постановщик',
  worker: 'Исполнитель',
};

export type TaskAction = { status: Status; label: string };
export function getActions(task: Task, profile: Profile): TaskAction[] {
  if (profile.role === 'manager' && task.status === 'review') {
    return [
      { status: 'accepted', label: 'Принять' },
      { status: 'revision', label: 'Вернуть на доработку' },
    ];
  }
  if (profile.role === 'worker' && task.assignee_id === profile.id) {
    if (task.status === 'new' || task.status === 'revision') {
      return [{ status: 'in_progress', label: 'Взять в работу' }];
    }
    if (task.status === 'in_progress') {
      return [{ status: 'review', label: 'Отправить на проверку' }];
    }
  }
  return [];
}

export function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
