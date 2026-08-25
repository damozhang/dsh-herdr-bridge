import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';
const execFileAsync = promisify(execFile);
export const name = 'herdr-bridge';
export const inject = ['tools'];
const DEFAULT_MODEL = 'opencode-go/deepseek-v4-pro';
const DEFAULT_SOCKET = join(homedir(), '.config', 'herdr', 'herdr.sock');
/** Run a herdr CLI command; returns stdout (or stderr if stdout is empty). */
async function runHerdr(args, opts) {
    const { stdout, stderr } = await execFileAsync('herdr', args, {
        env: {
            ...process.env,
            HERDR_ENV: '1',
            HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? DEFAULT_SOCKET,
        },
        timeout: opts.timeoutMs ?? 60_000,
        signal: opts.signal,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (stdout.trim() === '' && stderr.trim() !== '')
        return stderr;
    return stdout;
}
/** herdr CLI emits JSON envelopes on success; fall back to raw text. */
function parseEnvelope(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'result' in parsed)
            return parsed.result;
        return parsed;
    }
    catch {
        return { raw };
    }
}
/** Extract a text-ish value from a parsed envelope or raw output. */
function asText(value) {
    if (typeof value === 'string')
        return value;
    if (value == null)
        return '';
    return value.content ?? value.raw ?? JSON.stringify(value);
}
/** Create a workspace and return { workspaceId, paneId }. */
async function createWorkspace(cwd, label, signal) {
    const raw = await runHerdr(['workspace', 'create', '--cwd', cwd, '--label', label], {
        signal,
        timeoutMs: 30_000,
    });
    const ws = parseEnvelope(raw);
    const workspaceId = ws.workspace?.workspace_id ?? ws.root_pane?.workspace_id ?? '';
    const paneId = ws.root_pane?.pane_id ?? '';
    if (!paneId)
        throw new Error(`could not extract pane id from workspace create: ${raw.slice(0, 300)}`);
    return { workspaceId, paneId };
}
const text = { type: 'string' };
const optionalText = { type: 'string' };
const optionalNumber = { type: 'number' };
const optionalBool = { type: 'boolean' };
export function apply(ctx) {
    // 1. List agents/panes so the agent can discover targets and pick one.
    ctx.tools.register(defineTool({
        name: 'herdr_agent_list',
        description: 'List the agents currently running under Herdr (pi, claude, etc.) with their pane id, status, workspace, and working directory. Use to discover a target for herdr_delegate or herdr_agent_prompt.',
        parameters: {},
        output: {
            schema: {
                type: 'string',
            },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(_args, exec) {
            const raw = await runHerdr(['agent', 'list'], { signal: exec.signal, timeoutMs: 30_000 });
            const result = parseEnvelope(raw);
            const agents = result.agents ?? [];
            const lines = agents.map((a) => `${a.agent}\tpane=${a.pane_id}\tstatus=${a.agent_status}\tcwd=${a.cwd ?? ''}`);
            return lines.join('\n') || raw;
        },
    }));
    // 2. Start a fresh agent in a new workspace (or an existing pane).
    ctx.tools.register(defineTool({
        name: 'herdr_agent_start',
        description: 'Start a new interactive agent under Herdr. Creates a fresh workspace at cwd, launches the requested agent kind (pi, claude, codex, gemini, ...) with an optional model, and returns the workspace id and pane id for later prompts.',
        parameters: {
            cwd: { ...text, required: true, description: 'Absolute working directory for the new agent' },
            kind: { ...optionalText, description: 'Agent kind (default: pi)' },
            model: { ...optionalText, description: `Model pattern for pi, e.g. ${DEFAULT_MODEL}` },
            name: { ...optionalText, description: 'Agent name (default: auto-generated)' },
            label: { ...optionalText, description: 'Workspace label (default: agent-<kind>-<time>)' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workspaceId: { ...text, required: true },
                    paneId: { ...text, required: true },
                    agentName: { ...text, required: true },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: `Started agent ${value.agentName} (workspace ${value.workspaceId}, pane ${value.paneId})` },
            ],
        },
        async execute(args, exec) {
            const kind = args.kind ?? 'pi';
            const suffix = Date.now().toString(36);
            const agentName = args.name ?? `${kind}-${suffix}`;
            const { workspaceId, paneId } = await createWorkspace(args.cwd, args.label ?? `${kind}-${suffix}`, exec.signal);
            const startArgs = ['agent', 'start', agentName, '--kind', kind, '--pane', paneId, '--timeout', '90000'];
            if (args.model)
                startArgs.push('--', '--model', args.model);
            await runHerdr(startArgs, { signal: exec.signal, timeoutMs: 100_000 });
            return { workspaceId, paneId, agentName };
        },
    }));
    // 3. Submit a task to an agent, wait for completion, and read its output.
    ctx.tools.register(defineTool({
        name: 'herdr_agent_prompt',
        description: 'Send a message to a Herdr agent (by pane id), wait until it finishes, and return the agent terminal output. Use after herdr_agent_start. Long tasks need a large timeoutMs.',
        parameters: {
            paneId: { ...text, required: true, description: 'Pane id of the target agent (from herdr_agent_list or herdr_agent_start)' },
            message: { ...text, required: true, description: 'Task instructions for the agent' },
            timeoutMs: { ...optionalNumber, description: 'Wait timeout in ms (default: 600000)' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    paneId: { ...text, required: true },
                    output: { ...text, required: true },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: `--- agent output (${value.paneId}) ---\n${value.output}` },
            ],
        },
        async execute(args, exec) {
            const waitMs = args.timeoutMs ?? 600_000;
            await runHerdr(['agent', 'prompt', args.paneId, args.message, '--wait', '--timeout', String(waitMs)], { signal: exec.signal, timeoutMs: waitMs + 30_000 });
            const readRaw = await runHerdr(['agent', 'read', args.paneId], {
                signal: exec.signal,
                timeoutMs: 30_000,
            });
            return { paneId: args.paneId, output: asText(parseEnvelope(readRaw)).trim() };
        },
    }));
    // 4. One-shot: start an agent, delegate a task, wait, read output, optionally clean up.
    ctx.tools.register(defineTool({
        name: 'herdr_delegate',
        description: 'Delegate a task to a fresh Herdr agent in one step: create a workspace at cwd, start the requested agent kind/model, submit the task, wait for completion, return the output. Optionally close the workspace afterwards. This is the recommended way to have pi (or another agent) do work for this session.',
        parameters: {
            task: { ...text, required: true, description: 'Task instructions for the delegated agent' },
            cwd: { ...text, required: true, description: 'Absolute directory for the delegated agent' },
            kind: { ...optionalText, description: 'Agent kind (default: pi)' },
            model: { ...optionalText, description: `Model pattern (default: ${DEFAULT_MODEL})` },
            timeoutMs: { ...optionalNumber, description: 'Wait timeout in ms (default: 600000)' },
            closeWorkspace: { ...optionalBool, description: 'Close the workspace after reading output (default: false)' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workspaceId: { ...text, required: true },
                    paneId: { ...text, required: true },
                    agentName: { ...text, required: true },
                    output: { ...text, required: true },
                },
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: `Delegated to ${value.agentName} (workspace ${value.workspaceId}, pane ${value.paneId})\n` +
                        `--- agent output ---\n${value.output}`,
                },
            ],
        },
        async execute(args, exec) {
            const kind = args.kind ?? 'pi';
            const waitMs = args.timeoutMs ?? 600_000;
            const suffix = Date.now().toString(36);
            const agentName = `${kind}-${suffix}`;
            let workspaceId = '';
            try {
                const ws = await createWorkspace(args.cwd, `${kind}-${suffix}`, exec.signal);
                workspaceId = ws.workspaceId;
                const startArgs = ['agent', 'start', agentName, '--kind', kind, '--pane', ws.paneId, '--timeout', '90000'];
                if (args.model)
                    startArgs.push('--', '--model', args.model);
                await runHerdr(startArgs, { signal: exec.signal, timeoutMs: 100_000 });
                await runHerdr(['agent', 'prompt', ws.paneId, args.task, '--wait', '--timeout', String(waitMs)], { signal: exec.signal, timeoutMs: waitMs + 30_000 });
                const readRaw = await runHerdr(['agent', 'read', ws.paneId], {
                    signal: exec.signal,
                    timeoutMs: 30_000,
                });
                return {
                    workspaceId: ws.workspaceId,
                    paneId: ws.paneId,
                    agentName,
                    output: asText(parseEnvelope(readRaw)).trim(),
                };
            }
            finally {
                if (args.closeWorkspace && workspaceId) {
                    await runHerdr(['workspace', 'close', workspaceId], { signal: exec.signal, timeoutMs: 30_000 }).catch(() => { });
                }
            }
        },
    }));
    // 5. Run an arbitrary shell command in a pane.
    ctx.tools.register(defineTool({
        name: 'herdr_pane_run',
        description: 'Run a shell command inside an existing Herdr pane (by pane id) and return its output. For commands that produce a distinctive trailing line, pass matchText to wait for it instead of a fixed sleep.',
        parameters: {
            paneId: { ...text, required: true, description: 'Pane id (from herdr_agent_list or a workspace create)' },
            command: { ...text, required: true, description: 'Shell command to run' },
            matchText: { ...optionalText, description: 'Wait for this literal text in pane output before reading (optional)' },
            timeoutMs: { ...optionalNumber, description: 'Wait timeout in ms (default: 120000)' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    paneId: { ...text, required: true },
                    output: { ...text, required: true },
                },
            },
            render: (_args, value) => [
                { type: 'text', text: `--- pane output (${value.paneId}) ---\n${value.output}` },
            ],
        },
        async execute(args, exec) {
            const waitMs = args.timeoutMs ?? 120_000;
            await runHerdr(['pane', 'run', args.paneId, args.command], {
                signal: exec.signal,
                timeoutMs: 30_000,
            });
            if (args.matchText) {
                await runHerdr(['pane', 'wait-output', args.paneId, '--match', args.matchText, '--timeout', String(waitMs)], { signal: exec.signal, timeoutMs: waitMs + 30_000 });
            }
            else {
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            const readRaw = await runHerdr(['pane', 'read', args.paneId], {
                signal: exec.signal,
                timeoutMs: 30_000,
            });
            return { paneId: args.paneId, output: asText(parseEnvelope(readRaw)).trim() };
        },
    }));
    // 6. Close a workspace to clean up.
    ctx.tools.register(defineTool({
        name: 'herdr_workspace_close',
        description: 'Close a Herdr workspace (by workspace id), terminating its agents and panes.',
        parameters: {
            workspaceId: { ...text, required: true, description: 'Workspace id to close' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workspaceId: { ...text, required: true },
                    closed: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Workspace ${value.workspaceId} closed` }],
        },
        async execute(args, exec) {
            await runHerdr(['workspace', 'close', args.workspaceId], {
                signal: exec.signal,
                timeoutMs: 30_000,
            });
            return { workspaceId: args.workspaceId, closed: true };
        },
    }));
}
