export class ConnectorError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code = "CONNECTOR_ERROR", details?: unknown) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.details = details;
  }
}

export function serializeError(error: unknown): { message: string; code?: string; details?: unknown } {
  if (error instanceof ConnectorError) {
    return { message: error.message, code: error.code, details: error.details };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}
