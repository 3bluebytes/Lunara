export class ServiceError extends Error {
  constructor(statusCode, message, code = 'service_error') {
    super(message);
    this.name = 'ServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
