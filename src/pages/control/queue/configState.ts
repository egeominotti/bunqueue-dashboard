import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  currentServerActionIdentity,
  type ServerActionLease,
  useServerActionGuard,
} from '@/lib/useServerActionGuard';
import { configSig } from './configModel';

export function useSyncedConfig<T>(
  config: T
): [T, (value: T) => void, () => (saved: unknown) => void] {
  const [value, setValue] = useState(config);
  const lastServer = useRef(configSig(config));
  useEffect(() => {
    const next = configSig(config);
    if (next !== lastServer.current) {
      lastServer.current = next;
      setValue(config);
    }
  }, [config]);
  const beginSave = () => {
    const base = lastServer.current;
    return (saved: unknown) => {
      if (lastServer.current === base) lastServer.current = configSig(saved);
    };
  };
  return [value, setValue, beginSave];
}

export function useConfigSaveGuard(ownerKey: string) {
  const { scopeKey, begin } = useServerActionGuard(ownerKey);
  const active = useRef<ServerActionLease | null>(null);
  const savedTimer = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is intentionally a reset trigger.
  useEffect(() => {
    active.current = null;
    setSaving(false);
    setSaved(false);
    if (savedTimer.current !== null) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
    let connectionIdentity = currentServerActionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const nextIdentity = currentServerActionIdentity();
      if (nextIdentity === connectionIdentity) return;
      connectionIdentity = nextIdentity;
      active.current = null;
      setSaving(false);
      setSaved(false);
      if (savedTimer.current !== null) {
        window.clearTimeout(savedTimer.current);
        savedTimer.current = null;
      }
    });
    return () => {
      active.current = null;
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      unsubscribe();
    };
  }, [scopeKey]);

  const start = () => {
    const lease = begin('save');
    if (!lease) return null;
    active.current = lease;
    setSaving(true);
    setSaved(false);
    return lease;
  };
  const finish = (lease: ServerActionLease) => {
    lease.finish();
    if (active.current === lease) {
      active.current = null;
      setSaving(false);
    }
  };
  const showSaved = (lease: ServerActionLease) => {
    if (active.current !== lease || !lease.isCurrent()) return;
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => {
      if (lease.isCurrent()) setSaved(false);
      savedTimer.current = null;
    }, 2000);
  };
  return { scopeKey, saving, saved, start, finish, showSaved };
}
