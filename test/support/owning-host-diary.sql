-- Executable design proof in a disposable authorized-host schema, never an Abby migration.
create table diary (
  tenant_id uuid not null,
  appointment_id uuid not null,
  patient_id uuid not null,
  practitioner_id uuid not null,
  business_id uuid not null,
  type_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  revision bigint not null default 1,
  primary key (tenant_id, appointment_id),
  check (isfinite(starts_at) and isfinite(ends_at) and starts_at < ends_at),
  exclude using gist (tenant_id with =, practitioner_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&) where (active)
);

-- Every update, including native UI/API edits, advances the target version.
create function advance_revision() returns trigger language plpgsql as $$
begin
  if new.tenant_id <> old.tenant_id or new.appointment_id <> old.appointment_id then
    raise exception 'diary identity is immutable' using errcode = '23514';
  end if;
  new.revision := old.revision + 1; return new;
end $$;
create trigger diary_revision before update on diary
  for each row execute function advance_revision();

-- Tombstoning preserves identity/version history; writer roles cannot delete and reuse an ID.
create function refuse_diary_removal() returns trigger language plpgsql as $$
begin raise exception 'diary identity must be retained' using errcode = '23514'; end $$;
create trigger diary_no_delete before delete on diary
  for each row execute function refuse_diary_removal();
create trigger diary_no_truncate before truncate on diary
  for each statement execute function refuse_diary_removal();

create table receipts (
  tenant_id uuid not null,
  attempt_id uuid not null,
  request jsonb not null,
  result jsonb,
  primary key (tenant_id, attempt_id)
);

-- One host transaction owns the mutation and receipt. Caller authorization is upstream.
-- Identifiers and times are host-validated; JSON is only the server-built exact binding.
create function commit_diary(operation text, tenant uuid, attempt uuid, appointment uuid,
  patient uuid, practitioner uuid, business uuid, service uuid, expected_revision bigint,
  start_time timestamptz, end_time timestamptz) returns jsonb language plpgsql as $$
declare
  binding jsonb := jsonb_build_object('operation', operation, 'appointment', appointment,
    'patient', patient, 'practitioner', practitioner, 'business', business, 'service', service,
    'revision', expected_revision, 'start', start_time, 'end', end_time);
  previous receipts%rowtype;
  changed diary%rowtype;
  outcome jsonb;
begin
  if operation is null or operation not in ('book', 'cancel', 'move')
    or tenant is null or attempt is null or appointment is null or patient is null
    or practitioner is null or business is null or service is null
    or (operation = 'book' and expected_revision is not null)
    or (operation <> 'book' and (expected_revision is null or expected_revision < 1))
    or (operation <> 'cancel' and (start_time is null or end_time is null
      or not isfinite(start_time) or not isfinite(end_time) or start_time >= end_time))
    or (operation = 'cancel' and (start_time is not null or end_time is not null)) then
    return jsonb_build_object('kind', 'invalidRequest');
  end if;

  insert into receipts values (tenant, attempt, binding, null) on conflict do nothing;
  select * into strict previous from receipts
    where tenant_id = tenant and attempt_id = attempt for update;
  if previous.request <> binding then return jsonb_build_object('kind', 'requestMismatch'); end if;
  if previous.result is not null then return previous.result; end if;

  -- A constraint failure rolls back the mutation in this block, preserving the old row.
  begin
    if operation = 'book' then
      insert into diary (tenant_id, appointment_id, patient_id, practitioner_id, business_id,
        type_id, starts_at, ends_at) values
        (tenant, appointment, patient, practitioner, business, service, start_time, end_time)
        returning * into changed;
    else
      update diary set
        active = case when operation = 'cancel' then false else active end,
        starts_at = case when operation = 'move' then start_time else starts_at end,
        ends_at = case when operation = 'move' then end_time else ends_at end
      where tenant_id = tenant and appointment_id = appointment and active
        and revision = expected_revision and patient_id = patient and practitioner_id = practitioner
        and business_id = business and type_id = service returning * into changed;
    end if;
    outcome := case when changed.appointment_id is null
      then jsonb_build_object('kind', 'targetChanged')
      else jsonb_build_object('kind', 'committed', 'operation', operation, 'appointment', to_jsonb(changed)) end;
  exception
    when exclusion_violation then outcome := jsonb_build_object('kind', 'slotUnavailable');
    when unique_violation then outcome := jsonb_build_object('kind', 'targetChanged');
  end;
  update receipts set result = outcome where tenant_id = tenant and attempt_id = attempt;
  return outcome;
end $$;
