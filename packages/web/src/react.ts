export interface FormAction<TInput, TOutput> {
  readonly name: string;
  run(input: TInput, signal: AbortSignal): Promise<TOutput>;
}

/** Define the validated application function that a React server action delegates to. */
export function formAction<TInput, TOutput>(definition: {
  readonly name: string;
  readonly run: (input: TInput, signal: AbortSignal) => Promise<TOutput> | TOutput;
}): FormAction<TInput, TOutput> {
  if (!definition.name) throw new TypeError("FORM_ACTION_NAME_REQUIRED");
  return Object.freeze({
    name: definition.name,
    run: async (input: TInput, signal: AbortSignal) => definition.run(input, signal),
  });
}
