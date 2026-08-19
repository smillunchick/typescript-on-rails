export interface ArchitectureAllowance {
  readonly kind: "architecture-allowance";
  readonly rule: string;
  readonly reason: string;
  readonly expires?: string;
}

export const architecture = {
  allow(definition: Omit<ArchitectureAllowance, "kind">): ArchitectureAllowance {
    return { kind: "architecture-allowance", ...definition };
  },
};
