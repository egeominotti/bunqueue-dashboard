import { useAlertEngine } from '@/lib/useAlertEngine';

/**
 * Headless: runs the client-side alert evaluation loop for the whole app. Mounted
 * once in AppLayout so alerts fire regardless of which page is open.
 */
export function AlertEngine() {
  useAlertEngine();
  return null;
}
