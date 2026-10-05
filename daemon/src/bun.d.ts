interface BunSecretsGetArgs { service: string; name: string }
interface BunSecretsSetArgs { service: string; name: string; value: string }
interface BunSecretsDeleteArgs { service: string; name: string }

interface BunSecrets {
  get(args: BunSecretsGetArgs): Promise<string | null>;
  set(args: BunSecretsSetArgs): Promise<void>;
  delete(args: BunSecretsDeleteArgs): Promise<void>;
}

declare const Bun: {
  secrets: BunSecrets;
};
