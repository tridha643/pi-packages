/** A successful or expected failed operation at the Composio CLI boundary. */
export type ComposioResult<T, E> =
  | { readonly _tag: "success"; readonly value: T }
  | { readonly _tag: "failure"; readonly error: E };

/** Construct a successful Composio boundary result. */
export function composioSuccess<T>(value: T): ComposioResult<T, never> {
  return { _tag: "success", value };
}

/** Construct an expected failed Composio boundary result. */
export function composioFailure<E>(error: E): ComposioResult<never, E> {
  return { _tag: "failure", error };
}
