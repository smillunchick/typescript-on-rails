interface ConfiguredAdapter {
  readonly contract: { readonly name: string };
}

type AdapterInstances = Readonly<Record<string, ConfiguredAdapter>>;

export interface App<TAdapters extends AdapterInstances> {
  readonly adapters: TAdapters;
  readonly metadata: {
    readonly kind: "app";
    readonly adapters: Readonly<Record<string, string>>;
  };
}

function isAdapterInstances(value: unknown): value is AdapterInstances {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((adapter) => {
    if (typeof adapter !== "object" || adapter === null || !("contract" in adapter)) return false;
    const contract = adapter.contract;
    return typeof contract === "object" && contract !== null && "name" in contract && typeof contract.name === "string";
  });
}

export function defineApp<const TAdapters extends AdapterInstances>(config: { readonly adapters: TAdapters }): App<TAdapters>;
export function defineApp(config?: { readonly adapters?: undefined }): App<Record<string, never>>;
export function defineApp(config: unknown = undefined): unknown {
  let adapters: AdapterInstances = {};
  if (typeof config === "object" && config !== null && "adapters" in config && config.adapters !== undefined) {
    if (!isAdapterInstances(config.adapters)) throw new TypeError("App adapters must be configured adapter instances");
    adapters = config.adapters;
  }

  const metadataAdapters: Record<string, string> = {};
  for (const [name, adapter] of Object.entries(adapters)) metadataAdapters[name] = adapter.contract.name;
  return {
    adapters,
    metadata: { kind: "app", adapters: metadataAdapters },
  };
}
