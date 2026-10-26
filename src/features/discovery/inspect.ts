import {
  captureConnectionProfileTarget,
  type ConnectionProfileTarget,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';

export function activateResultProfile(source: Readonly<ConnectionProfileTarget>): void {
  const current = captureConnectionProfileTarget(source.id);
  if (
    !current ||
    ['baseUrl', 'agentBaseUrl', 'token', 'agentToken', 'name'].some(
      (key) =>
        current[key as keyof ConnectionProfileTarget] !==
        source[key as keyof ConnectionProfileTarget]
    )
  ) {
    throw new Error('Source profile changed after this scan. Run a new scan before inspecting.');
  }
  if (!useConnectionStore.getState().activateProfile(source.id))
    throw new Error('Source profile no longer exists.');
}
