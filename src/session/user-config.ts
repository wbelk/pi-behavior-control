import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Cross-runtime agent-dir resolution + persisted config IO.
// Spec: section 4 (env var verified for both pi and OMP) and section 8.

/** Injected dependencies for `resolveAgentDir` — overridable in tests. */
export interface AgentDirInputs {
	envValue: string | undefined;
	homeDir: string;
	exists: (path: string) => boolean;
}

/**
 * Pure resolver for the pi/OMP agent directory. Order:
 *
 *   1. `envValue` (typically `process.env.PI_CODING_AGENT_DIR`) — honored
 *      by both upstream pi and OMP. `~` is expanded against `homeDir`.
 *   2. `<homeDir>/.omp/agent` if `exists(...)` returns true (OMP is active).
 *   3. `<homeDir>/.pi/agent` if `exists(...)` returns true (upstream pi).
 *   4. `<homeDir>/.pi/agent` as the default for a fresh upstream-pi install.
 *
 * The "both exist" case → returns `.omp` (OMP gets priority because it's
 * the newer fork and a user who has both probably wants OMP).
 */
export function resolveAgentDir(inputs: AgentDirInputs): string {
	if (inputs.envValue && inputs.envValue.length > 0) {
		return path.resolve(expandHome(inputs.envValue, inputs.homeDir));
	}
	const ompDir = path.join(inputs.homeDir, ".omp", "agent");
	const piDir = path.join(inputs.homeDir, ".pi", "agent");
	if (inputs.exists(ompDir)) return ompDir;
	if (inputs.exists(piDir)) return piDir;
	return piDir;
}

/**
 * Production-facing agent dir resolver. Wires `resolveAgentDir` with the
 * real `process.env`, `os.homedir()`, and `fs.existsSync`. Re-evaluated on
 * every call so a runtime that creates its dir mid-session is picked up
 * without restarting.
 */
export function agentDir(): string {
	return resolveAgentDir({
		envValue: process.env.PI_CODING_AGENT_DIR,
		homeDir: os.homedir(),
		exists: fs.existsSync,
	});
}

/**
 * Expand a leading `~` segment against the user's home directory.
 * `"~"`, `"~/foo"`, `"~\\foo"` are expanded; absolute paths pass through.
 * `home` defaults to `os.homedir()`; pass an override for tests.
 */
export function expandHome(p: string, home: string = os.homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(home, p.slice(2));
	}
	return p;
}

const CONFIG_SUBDIR = "behavior-control";
const CONFIG_FILENAME = "config.json";

/** Absolute path to this plugin's persisted config file. */
export function configPath(): string {
	return path.join(agentDir(), CONFIG_SUBDIR, CONFIG_FILENAME);
}

// =============================================================================
// Persisted config shape
// =============================================================================

export interface VerifierModel {
	provider: string;
	id: string;
}

/**
 * Persisted verifier preference. Either an explicit provider/id pair, or
 * the literal "session-model" indicating "use whatever ctx.model is at
 * each agent_end."
 */
export type VerifierChoice = VerifierModel | "session-model";

export interface UserConfig {
	verifier?: VerifierChoice;
}

/**
 * Load the persisted config. Returns null if the file does not exist or
 * cannot be parsed. The plugin is expected to recover by treating "no
 * persisted config" as "first run, use defaults".
 */
export function loadConfig(): UserConfig | null {
	const p = configPath();
	if (!fs.existsSync(p)) return null;
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as { verifier?: unknown };
		if (obj.verifier !== undefined && !isVerifierChoice(obj.verifier)) {
			// Persisted value is malformed (older or hand-edited config). Treat
			// as no preference so the user is re-prompted.
			return {};
		}
		return obj as UserConfig;
	} catch {
		return null;
	}
}

function isVerifierChoice(value: unknown): value is VerifierChoice {
	if (value === "session-model") return true;
	if (!value || typeof value !== "object") return false;
	const m = value as Partial<VerifierModel>;
	return (
		typeof m.provider === "string" &&
		m.provider.length > 0 &&
		typeof m.id === "string" &&
		m.id.length > 0
	);
}

/**
 * Atomic save: write to `<configPath>.tmp.<pid>` then rename. Ensures the
 * parent directory exists. Throws on filesystem failure — callers should
 * surface the error rather than swallowing it (a failed save means the
 * user's selection will be re-prompted next session, which is recoverable
 * but worth knowing about).
 */
export function saveConfig(config: UserConfig): void {
	const p = configPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, p);
}
