export class IngestionError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "IngestionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
