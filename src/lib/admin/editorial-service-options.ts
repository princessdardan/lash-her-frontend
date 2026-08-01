export interface OptionalEditorialServiceOptions<T> {
  isAvailable: boolean;
  services: T[];
}

export async function resolveOptionalEditorialServiceOptions<T>(
  load: () => Promise<T[]>,
): Promise<OptionalEditorialServiceOptions<T>> {
  try {
    return {
      isAvailable: true,
      services: await load(),
    };
  } catch {
    return {
      isAvailable: false,
      services: [],
    };
  }
}
