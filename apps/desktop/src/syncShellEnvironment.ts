import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";

const BEDROCK_ENV_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "AWS_PROFILE",
  "CLAUDE_CODE_BEDROCK_MODEL_HAIKU",
  "CLAUDE_CODE_BEDROCK_MODEL_SONNET",
  "CLAUDE_CODE_BEDROCK_MODEL_OPUS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
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
      ...BEDROCK_ENV_VARS,
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of BEDROCK_ENV_VARS) {
      if (!env[name] && shellEnvironment[name]) {
        env[name] = shellEnvironment[name];
      }
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
