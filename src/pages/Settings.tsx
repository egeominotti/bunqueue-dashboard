import { PageHeader } from '@/components/ui/PageHeader';
import { AppearanceCard } from './settings/AppearanceCard';
import { ConnectionProfilesCard } from './settings/ConnectionProfilesCard';

export { isValidBaseUrl } from '@/components/dashboard/stores/connectionStore';
export { fetchHealthWithTimeout, SETTINGS_TEST_TIMEOUT_MS } from './settings/health';

export function Settings() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Bunqueue fleet connections, credentials and appearance."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ConnectionProfilesCard />
        <AppearanceCard />
      </div>
    </div>
  );
}
