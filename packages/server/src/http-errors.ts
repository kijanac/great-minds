import { DomainErrorSchema, type DomainError } from "@great-minds/domain";
import { Schema } from "effect";

type HttpErrorResponse = {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  readonly body: typeof DomainErrorSchema.Encoded;
};

const encodeDomainError = Schema.encodeSync(DomainErrorSchema);

const statusOf = (error: DomainError): HttpErrorResponse["status"] => {
  switch (error._tag) {
    case "Unauthorized":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Validation":
      return 422;
    case "BadRequest":
      return 400;
    case "Conflict":
      return 409;
    case "ServiceUnavailable":
      return 503;
  }
};

export const domainErrorResponse = (error: DomainError): HttpErrorResponse => ({
  status: statusOf(error),
  body: encodeDomainError(error),
});
