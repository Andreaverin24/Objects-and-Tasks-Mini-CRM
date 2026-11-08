-- Run once after creating the three confirmed users listed in README.md.
begin;

do $$
declare
  manager_id uuid;
  worker_a uuid;
  worker_b uuid;
  site_a uuid;
  site_b uuid;
  new_task uuid;
  review_task uuid;
  accepted_task uuid;
begin
  select id into strict manager_id from auth.users where email = 'manager@crm-demo.example.com';
  select id into strict worker_a from auth.users where email = 'worker-a@crm-demo.example.com';
  select id into strict worker_b from auth.users where email = 'worker-b@crm-demo.example.com';

  insert into public.profiles (id, name, role) values
    (manager_id, 'Марина Орлова', 'manager'),
    (worker_a, 'Алексей Смирнов', 'worker'),
    (worker_b, 'Анна Волкова', 'worker');

  insert into public.sites (name, address)
  values ('ЖК «Северный»', 'ул. Строителей, 12') returning id into site_a;
  insert into public.sites (name, address)
  values ('Склад «Маяк»', 'Промышленный проезд, 4') returning id into site_b;

  perform set_config('request.jwt.claim.sub', manager_id::text, true);
  insert into public.tasks (site_id, title, description, assignee_id)
  values (site_a, 'Проверить разметку фундамента', 'Сверить отметки с планом и зафиксировать отклонения.', worker_a);

  insert into public.tasks (site_id, title, description, assignee_id)
  values (site_a, 'Сверить комплект крепежа', 'Проверить количество деталей по накладной.', worker_b)
  returning id into review_task;

  insert into public.tasks (site_id, title, description, assignee_id)
  values (site_b, 'Принять материалы на складе', 'Сверить количество и состояние упаковок.', worker_b)
  returning id into accepted_task;

  insert into public.tasks (site_id, title, description, assignee_id)
  values (site_b, 'Проверить временное освещение', 'Проверить проходы и точки подключения.', worker_b)
  returning id into new_task;

  perform set_config('request.jwt.claim.sub', worker_b::text, true);
  perform public.transition_task(review_task, 'in_progress');
  perform public.transition_task(review_task, 'review', 'Комплект сверен.');
  perform public.transition_task(accepted_task, 'in_progress');
  perform public.transition_task(accepted_task, 'review');
  perform public.transition_task(new_task, 'in_progress');

  perform set_config('request.jwt.claim.sub', manager_id::text, true);
  perform public.transition_task(accepted_task, 'accepted');
end;
$$;

commit;
