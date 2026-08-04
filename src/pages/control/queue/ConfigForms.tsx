import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';

export {
  type ConfigValidation,
  configSig,
  type DlqDraft,
  dlqConfigMutationPayload,
  dlqConfigPayload,
  isDlqConfig,
  isStallConfig,
  type MutableDlqConfig,
  type StallDraft,
  stallConfigPayload,
} from './configModel';
export { useSyncedConfig } from './configState';
export { DlqConfigForm } from './DlqConfigForm';
export { StallForm } from './StallForm';

export function ConfigLoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader title={title} />
      <p className="mb-3 text-sm text-muted">Couldn't load this queue's config.</p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}
