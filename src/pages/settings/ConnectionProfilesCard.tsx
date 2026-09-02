import { useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { IconEye } from '@/components/ui/icons';
import { useConnectionProfileEditor } from './useConnectionProfileEditor';

function SecretField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="pr-10"
          autoComplete="off"
          spellCheck={false}
        />
        <IconButton
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-0.5 top-1/2 -translate-y-1/2"
          onClick={() => setVisible((current) => !current)}
        >
          <IconEye className="size-4" />
        </IconButton>
      </div>
    </Field>
  );
}

export function ConnectionProfilesCard() {
  const editor = useConnectionProfileEditor();
  const change = (setter: (value: string) => void) => (value: string) => {
    editor.edit();
    setter(value);
  };

  return (
    <Card>
      <CardHeader title="Bunqueue fleet connections" />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Field label="Active node">
            <Select
              aria-label="Active Bunqueue node"
              value={editor.activeProfileId}
              onChange={(event) => editor.activateProfile(event.target.value)}
            >
              {editor.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button className="self-end" onClick={editor.add}>
            Add node
          </Button>
          <Button
            className="self-end"
            variant="danger"
            disabled={editor.profiles.length === 1}
            onClick={editor.remove}
          >
            Remove
          </Button>
        </div>

        <Field label="Node name">
          <Input
            name="profile-name"
            value={editor.name}
            onChange={(event) => change(editor.setName)(event.target.value)}
            maxLength={64}
            autoComplete="off"
            placeholder="broker-eu-1"
          />
        </Field>
        <Field label="Server URL">
          <Input
            name="server-url"
            value={editor.url}
            onChange={(event) => {
              change(editor.setUrl)(event.target.value);
            }}
            placeholder="/api or https://queue.example.com"
            autoComplete="off"
            inputMode="url"
            aria-invalid={editor.urlError ? true : undefined}
            aria-describedby={editor.urlError ? 'server-url-error' : 'server-url-help'}
          />
        </Field>
        {editor.urlError ? (
          <p id="server-url-error" className="-mt-2 text-xs text-danger">
            {editor.urlError}
          </p>
        ) : (
          <p id="server-url-help" className="-mt-2 text-xs text-faint">
            Bunqueue HTTP API for this broker. All queue pages use the selected node.
          </p>
        )}
        <Field label="Control agent URL">
          <Input
            name="agent-url"
            value={editor.agentUrl}
            onChange={(event) => change(editor.setAgentUrl)(event.target.value)}
            placeholder="/agent or https://broker.example.com/agent"
            autoComplete="off"
            inputMode="url"
            aria-invalid={editor.agentUrlError ? true : undefined}
            aria-describedby={editor.agentUrlError ? 'agent-url-error' : 'agent-url-help'}
          />
        </Field>
        {editor.agentUrlError ? (
          <p id="agent-url-error" className="-mt-2 text-xs text-danger">
            {editor.agentUrlError}
          </p>
        ) : (
          <p id="agent-url-help" className="-mt-2 text-xs text-faint">
            One paired agent per broker enables lifecycle, configuration, Flow, Workflow and
            advanced queue controls.
          </p>
        )}
        <SecretField
          id="bearer-token"
          label="Bearer token (optional)"
          hint="Server credential, kept in memory only and isolated to this node."
          value={editor.tok}
          onChange={change(editor.setTok)}
          placeholder="only if AUTH_TOKENS is set"
        />
        <SecretField
          id="agent-token"
          label="Agent token (optional)"
          hint="AGENT_TOKEN for this node, kept in memory only."
          value={editor.agentTok}
          onChange={change(editor.setAgentTok)}
          placeholder="only if AGENT_TOKEN is set"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" onClick={editor.save}>
            Save
          </Button>
          <Button onClick={editor.testServer}>
            {editor.testing === 'server' ? 'Restart test' : 'Test connection'}
          </Button>
          <Button onClick={editor.testAgent}>
            {editor.testing === 'agent' ? 'Restart agent test' : 'Test agent'}
          </Button>
          {editor.saveNotice && (
            <span
              role="status"
              className={editor.saveNotice.ok ? 'text-sm text-success' : 'text-sm text-warning'}
            >
              {editor.saveNotice.msg}
            </span>
          )}
          {editor.result && (
            <span
              role="status"
              className={editor.result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
            >
              {editor.result.msg}
            </span>
          )}
        </div>
        <p className="-mt-1 text-xs text-faint">
          Switching the active node retargets every Dashboard feature atomically. Profile metadata
          persists; both credentials are erased on reload.
        </p>
      </div>
    </Card>
  );
}
