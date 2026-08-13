import { Badge, Empty, Panel, Row } from "@/components/ui";
import { getKeyStatus, getSettings, SEARCH_PROVIDERS } from "@/lib/settings";
import { getOrCreateDefaultWorkspace } from "@/lib/workspace";
import { clearModelKeyAction, setSearchProviderAction } from "./actions";
import { KeyForm } from "./key-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ws = await getOrCreateDefaultWorkspace();
  const row = await getSettings(ws.id);
  const key = await getKeyStatus(ws.id);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-3">
      <h1 className="text-[15px] font-medium">Settings</h1>

      <Panel title="Workspace">
        <Row label="Name">{ws.name}</Row>
        <Row label="Domain" mono>
          {ws.domain}
        </Row>
        <Row label="Locales" mono>
          {ws.locales.join(", ")}
        </Row>
        <Row label="Workspace ID" mono>
          <span className="text-dim">{ws.id}</span>
        </Row>
      </Panel>

      <Panel
        title="Model key (BYOK)"
        hint="encrypted at rest · never logged · never returned to the browser"
      >
        <div className="mb-3 pb-3 border-b border-edge/60">
          <Row label="Status">
            {key.state === "none" && (
              <span className="text-muted">
                No key stored.{" "}
                <span className="text-dim">
                  Model calls will fall back to the environment variable in local
                  development only.
                </span>
              </span>
            )}
            {key.state === "stored" && (
              <span className="flex items-center gap-2 flex-wrap">
                <Badge tone="ok">stored</Badge>
                <span className="font-mono">{key.masked}</span>
                <span className="text-dim">
                  updated {key.updatedAt.toISOString()}
                </span>
              </span>
            )}
            {key.state === "undecryptable" && (
              <span className="flex items-center gap-2 flex-wrap">
                <Badge tone="bad">undecryptable</Badge>
                <span className="text-muted">
                  A key is stored but this environment&apos;s APP_ENCRYPTION_KEY
                  cannot decrypt it. Re-enter the key.
                </span>
              </span>
            )}
          </Row>
          <Row label="Provider" mono>
            {row.modelProvider}
          </Row>
          {key.state !== "none" && (
            <div className="pt-2">
              <form action={clearModelKeyAction}>
                <button
                  type="submit"
                  className="text-[11px] text-bad hover:underline"
                >
                  Remove stored key
                </button>
              </form>
            </div>
          )}
        </div>

        <KeyForm currentProvider={row.modelProvider} />
      </Panel>

      <Panel title="Search provider" hint="used from Phase 3 onward">
        <form action={setSearchProviderAction} className="flex items-center gap-3">
          <select
            name="searchProvider"
            defaultValue={row.searchProvider}
            className="bg-input border border-edge-strong rounded px-2 py-1.5 text-[12px] font-mono w-48 focus:outline-none focus:border-accent"
          >
            {SEARCH_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 rounded bg-raised border border-edge-strong text-[12px] hover:border-accent transition-colors"
          >
            Save
          </button>
        </form>
        <div className="mt-2">
          <Empty>
            No search calls are made yet. Wired up with the strategy compiler in
            Phase 3.
          </Empty>
        </div>
      </Panel>
    </div>
  );
}
