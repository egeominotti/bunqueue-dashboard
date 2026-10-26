import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Card } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import type { DiscoveryQuery } from './model';

const STATES = [
  '',
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'paused',
  'waiting-children',
  'completed',
  'failed',
  'dlq',
];
function dateInput(value?: number): string {
  return value === undefined ? '' : new Date(value).toISOString().slice(0, 16);
}
export function DiscoveryFilters({
  query,
  onChange,
  failures = false,
}: {
  query: DiscoveryQuery;
  onChange: (query: DiscoveryQuery) => void;
  failures?: boolean;
}) {
  const profiles = useConnectionStore((state) => state.profiles);
  const update = (patch: Partial<DiscoveryQuery>) => onChange({ ...query, ...patch });
  return (
    <Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Search jobs"
          hint="ID, custom ID, name, queue, tag or top-level correlation ID."
        >
          <Input
            value={query.text ?? ''}
            onChange={(event) => update({ text: event.target.value })}
            placeholder="Find observed jobs…"
          />
        </Field>
        <Field label="Queue">
          <Input
            value={query.queue ?? ''}
            onChange={(event) => update({ queue: event.target.value })}
            placeholder="All queues"
          />
        </Field>
        {!failures && (
          <Field label="State">
            <Select
              value={query.state ?? ''}
              onChange={(event) => update({ state: event.target.value })}
            >
              {STATES.map((state) => (
                <option key={state} value={state}>
                  {state || 'All job states'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Minimum priority">
          <Input
            type="number"
            value={query.minPriority ?? ''}
            onChange={(event) =>
              update({
                minPriority: event.target.value === '' ? undefined : Number(event.target.value),
              })
            }
          />
        </Field>
        <Field label="Created from (UTC)">
          <Input
            type="datetime-local"
            value={dateInput(query.createdAfter)}
            onChange={(event) =>
              update({
                createdAfter: event.target.value ? Date.parse(`${event.target.value}Z`) : undefined,
              })
            }
          />
        </Field>
        <Field label="Created through (UTC)">
          <Input
            type="datetime-local"
            value={dateInput(query.createdBefore)}
            onChange={(event) =>
              update({
                createdBefore: event.target.value
                  ? Date.parse(`${event.target.value}Z`)
                  : undefined,
              })
            }
          />
        </Field>
      </div>
      <fieldset className="mt-4 flex flex-wrap gap-4 text-sm">
        <legend className="mb-2 text-xs text-muted">Profiles (none selected scans all)</legend>
        {profiles.map((profile) => (
          <label className="flex items-center gap-2" key={profile.id}>
            <input
              type="checkbox"
              checked={query.profiles?.includes(profile.id) ?? false}
              onChange={(event) =>
                update({
                  profiles: event.target.checked
                    ? [...(query.profiles ?? []), profile.id]
                    : query.profiles?.filter((id) => id !== profile.id),
                })
              }
            />
            {profile.name}
          </label>
        ))}
      </fieldset>
    </Card>
  );
}
