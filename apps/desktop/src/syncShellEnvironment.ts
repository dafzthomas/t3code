import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";

const AWS_ENV_VARS = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
] as const;

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
  } = {},
): void {
  if ((options.platform ?? process.platform) !== "darwin") return;

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "SSH_AUTH_SOCK",
      ...AWS_ENV_VARS,
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const key of AWS_ENV_VARS) {
      if (!env[key] && shellEnvironment[key]) {
        env[key] = shellEnvironment[key];
      }
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
