// RFC 7807 problem responses. Never leak stack traces or internal messages to clients.

export class HttpError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail || code);
    this.statusCode = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

export const badRequest = (code, detail, extra) => new HttpError(400, code, detail, extra);
export const unauthorized = (detail = 'Sign in required') => new HttpError(401, 'unauthorized', detail);
export const forbidden = (detail = 'Not allowed') => new HttpError(403, 'forbidden', detail);
export const notFound = (detail = 'Not found') => new HttpError(404, 'not_found', detail);
export const conflict = (code, detail, extra) => new HttpError(409, code, detail, extra);
export const tooMany = (detail = 'Too many requests') => new HttpError(429, 'rate_limited', detail);
export const unavailable = (code, detail) => new HttpError(503, code, detail);

const TITLES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

export function errorHandler(err, request, reply) {
  let status = err.statusCode || 500;
  let code = err.code || 'internal_error';
  let detail = err.detail;
  let extra = err.extra || {};

  if (err.validation) {
    status = 400;
    code = 'validation_failed';
    detail = 'Request did not match the expected format';
    extra = { errors: err.validation.map((v) => ({ path: v.instancePath || v.params?.missingProperty || '', message: v.message })) };
  } else if (!(err instanceof HttpError)) {
    if (status >= 500) {
      // Database connection problems become 503 so clients and load balancers retry.
      // Redis being down while a fail-closed limiter runs (auth, payments) is also a 503.
      if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|Connection terminated|the database system is|enableOfflineQueue|Connection is closed/i.test(String(err.message))) {
        status = 503;
        code = 'dependency_unavailable';
        reply.header('Retry-After', '5');
      }
      request.log.error({ err }, 'unhandled error');
      detail = status === 503
        ? 'A service we depend on is unavailable. Please try again shortly.'
        : 'Something went wrong. Quote the request id when contacting support.';
    } else {
      // Fastify's own 4xx errors (body too large, bad JSON, wrong content type).
      code = String(err.code || 'bad_request').toLowerCase();
      detail = err.message;
    }
  }

  reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `https://kagobuild.co.za/problems/${code}`,
      title: TITLES[status] || 'Error',
      status,
      code,
      detail,
      requestId: request.id,
      ...extra,
    });
}

export function notFoundHandler(request, reply) {
  reply.status(404).type('application/problem+json').send({
    type: 'https://kagobuild.co.za/problems/route_not_found',
    title: 'Not Found',
    status: 404,
    code: 'route_not_found',
    detail: 'No such route',
    requestId: request.id,
  });
}
