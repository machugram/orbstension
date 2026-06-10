import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';

const execFile = promisify(execFileCallback);

type MachineState = 'running' | 'stopped' | 'unknown';

interface OrbMachine {
  name: string;
  state: MachineState;
  distro: string;
  version: string;
  arch: string;
  size: string;
  ip?: string;
}

type OrbTreeItem = OrbMachineItem | OrbMessageItem;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OrbMachinesProvider();

  context.subscriptions.push(vscode.window.registerTreeDataProvider('orbstackMachines', provider));
  context.subscriptions.push(
    vscode.commands.registerCommand('orbstack.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('orbstack.startMachine', async (item?: OrbMachineItem) => {
      const machine = item?.machine ?? await provider.pickMachine('Select an OrbStack machine to start');
      if (!machine) {
        return;
      }

      await runOrbCommand(['start', machine.name], `Starting ${machine.name}...`, `${machine.name} started.`, provider);
    }),
    vscode.commands.registerCommand('orbstack.stopMachine', async (item?: OrbMachineItem) => {
      const machine = item?.machine ?? await provider.pickMachine('Select an OrbStack machine to stop');
      if (!machine) {
        return;
      }

      await runOrbCommand(['stop', machine.name], `Stopping ${machine.name}...`, `${machine.name} stopped.`, provider);
    }),
    vscode.commands.registerCommand('orbstack.openShell', async (item?: OrbMachineItem) => {
      const machine = item?.machine ?? await provider.pickMachine('Select an OrbStack machine to open a shell');
      if (!machine) {
        return;
      }

      const orbPath = await resolveOrbPath();

      const terminal = vscode.window.createTerminal({
        name: `OrbStack: ${machine.name}`
      });

      terminal.show();
      terminal.sendText(`${quoteForShell(orbPath)} -m ${quoteForShell(machine.name)}`, true);
    }),
    vscode.commands.registerCommand('orbstack.copyIp', async (item?: OrbMachineItem) => {
      const machine = item?.machine ?? await provider.pickMachine('Select an OrbStack machine to copy the IP address');
      if (!machine) {
        return;
      }

      if (!machine.ip) {
        void vscode.window.showInformationMessage(`No IP is available for ${machine.name}.`);
        return;
      }

      await vscode.env.clipboard.writeText(machine.ip);
      void vscode.window.showInformationMessage(`Copied ${machine.name} IP: ${machine.ip}`);
    }),
    vscode.commands.registerCommand('orbstack.showMachines', async () => {
      const machine = await provider.pickMachine('Select an OrbStack machine');
      if (!machine) {
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: 'Open shell', action: 'shell' },
          { label: machine.state === 'running' ? 'Stop machine' : 'Start machine', action: machine.state === 'running' ? 'stop' : 'start' },
          { label: 'Copy IP', action: 'copyIp' }
        ],
        { placeHolder: `${machine.name} is ${machine.state}` }
      );

      if (!action) {
        return;
      }

      if (action.action === 'shell') {
        await vscode.commands.executeCommand('orbstack.openShell', new OrbMachineItem(machine));
        return;
      }

      if (action.action === 'copyIp') {
        await vscode.commands.executeCommand('orbstack.copyIp', new OrbMachineItem(machine));
        return;
      }

      await vscode.commands.executeCommand(
        action.action === 'start' ? 'orbstack.startMachine' : 'orbstack.stopMachine',
        new OrbMachineItem(machine)
      );
    })
  );
}

export function deactivate(): void {}

class OrbMachinesProvider implements vscode.TreeDataProvider<OrbTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<OrbTreeItem | undefined | void>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: OrbTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: OrbTreeItem): Promise<OrbTreeItem[]> {
    if (element) {
      return [];
    }

    try {
      const machines = await listMachines();
      if (machines.length === 0) {
        return [new OrbMessageItem('No OrbStack machines found', 'Create or import a machine in OrbStack to see it here.')];
      }

      return machines.map((machine) => new OrbMachineItem(machine));
    } catch (error) {
      return [new OrbMessageItem('OrbStack unavailable', getErrorMessage(error))];
    }
  }

  async pickMachine(placeHolder: string): Promise<OrbMachine | undefined> {
    try {
      const machines = await listMachines();
      if (machines.length === 0) {
        void vscode.window.showInformationMessage('No OrbStack machines found.');
        return undefined;
      }

      const selection = await vscode.window.showQuickPick(
        machines.map((machine) => ({
          label: machine.name,
          description: `${machine.state} • ${machine.distro} ${machine.version}`,
          detail: [machine.arch, machine.size, machine.ip].filter(Boolean).join(' • '),
          machine
        })),
        { placeHolder }
      );

      return selection?.machine;
    } catch (error) {
      void vscode.window.showErrorMessage(`OrbStack command failed: ${getErrorMessage(error)}`);
      return undefined;
    }
  }
}

class OrbMachineItem extends vscode.TreeItem {
  constructor(readonly machine: OrbMachine) {
    super(machine.name, vscode.TreeItemCollapsibleState.None);

    this.id = machine.name;
    this.description = [machine.state, machine.distro, machine.version].filter(Boolean).join(' • ');
    this.tooltip = new vscode.MarkdownString([
      `**${machine.name}**`,
      '',
      `State: ${machine.state}`,
      `Distro: ${machine.distro || 'unknown'}`,
      `Version: ${machine.version || 'unknown'}`,
      `Arch: ${machine.arch || 'unknown'}`,
      `Size: ${machine.size || 'unknown'}`,
      machine.ip ? `IP: ${machine.ip}` : 'IP: unavailable'
    ].join('  \n'));
    this.contextValue = machine.state === 'running' ? 'machineRunning' : machine.state === 'stopped' ? 'machineStopped' : 'machineUnknown';
    this.iconPath = new vscode.ThemeIcon(machine.state === 'running' ? 'play-circle' : machine.state === 'stopped' ? 'debug-stop' : 'warning');
    this.command = {
      command: 'orbstack.openShell',
      title: 'Open Machine Shell',
      arguments: [this]
    };
  }
}

class OrbMessageItem extends vscode.TreeItem {
  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

async function runOrbCommand(
  args: string[],
  title: string,
  successMessage: string,
  provider: OrbMachinesProvider
): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title
      },
      async () => {
        await runOrb(args);
      }
    );

    provider.refresh();
    void vscode.window.showInformationMessage(successMessage);
  } catch (error) {
    void vscode.window.showErrorMessage(`OrbStack command failed: ${getErrorMessage(error)}`);
  }
}

async function listMachines(): Promise<OrbMachine[]> {
  const { stdout } = await runOrb(['list']);
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.startsWith('NAME'))
    .filter((line) => !/^[-\s]+$/.test(line));

  return lines.map(parseMachineLine).filter((machine): machine is OrbMachine => Boolean(machine));
}

function parseMachineLine(line: string): OrbMachine | undefined {
  const columns = line.split(/\s{2,}/).map((column) => column.trim());
  if (columns.length < 6) {
    return undefined;
  }

  return {
    name: columns[0],
    state: normalizeState(columns[1]),
    distro: columns[2] ?? '',
    version: columns[3] ?? '',
    arch: columns[4] ?? '',
    size: columns[5] ?? '',
    ip: columns[6] || undefined
  };
}

function normalizeState(value: string): MachineState {
  if (value === 'running' || value === 'stopped') {
    return value;
  }

  return 'unknown';
}

async function runOrb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const orbPath = await resolveOrbPath();
  const result = await execFile(orbPath, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30000
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const extra = extractExecOutput(error);
    return extra ? `${error.message}: ${extra}` : error.message;
  }

  return String(error);
}

function extractExecOutput(error: Error): string | undefined {
  const execError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : undefined;
  const stdout = typeof execError.stdout === 'string' ? execError.stdout.trim() : undefined;

  return stderr || stdout || undefined;
}

const ORB_CANDIDATE_PATHS = [
  '/usr/local/bin/orb',
  '/opt/homebrew/bin/orb',
  '/usr/bin/orb'
];

let resolvedOrbPath: string | undefined;

async function resolveOrbPath(): Promise<string> {
  if (resolvedOrbPath) {
    return resolvedOrbPath;
  }

  for (const candidate of ORB_CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      resolvedOrbPath = candidate;
      return resolvedOrbPath;
    }
  }

  // Fallback: ask the shell where orb is
  try {
    const { stdout } = await execFile('/bin/sh', ['-c', 'which orb'], {
      encoding: 'utf8',
      timeout: 5000
    });
    const found = stdout.trim();
    if (found) {
      resolvedOrbPath = found;
      return found;
    }
  } catch {
    // ignore
  }

  return 'orb'; // last resort
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}