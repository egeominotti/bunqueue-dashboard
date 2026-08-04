import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Select } from '@/components/ui/form';

const REFRESH_OPTIONS = [
  ['1000', '1 second'],
  ['2000', '2 seconds'],
  ['3000', '3 seconds'],
  ['5000', '5 seconds'],
  ['10000', '10 seconds'],
] as const;

export function AppearanceCard() {
  const { refreshMs, setRefreshMs } = useConnectionStore();
  const { theme, setTheme } = useThemeStore();
  return (
    <Card>
      <CardHeader title="Appearance & refresh" />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Theme">
          <Select
            name="theme"
            autoComplete="off"
            value={theme}
            onChange={(event) => setTheme(event.target.value as 'dark' | 'light')}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Select>
        </Field>
        <Field label="Refresh interval">
          <Select
            name="refresh-interval"
            autoComplete="off"
            value={String(refreshMs)}
            onChange={(event) => setRefreshMs(Number(event.target.value))}
          >
            {REFRESH_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}
