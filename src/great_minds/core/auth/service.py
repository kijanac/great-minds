"""Auth service: code generation and email delivery."""

import logging

import resend

from great_minds.core.settings import Settings

log = logging.getLogger(__name__)


def send_auth_code(email: str, code: str, settings: Settings) -> None:
    if settings.resend_api_key is None:
        log.warning("resend_api_key not set — logging auth code for dev: email=%s code=%s", email, code)
        return

    resend.api_key = settings.resend_api_key
    resend.Emails.send(
        {
            "from": settings.resend_from_email,
            "to": email,
            "subject": "Your sign-in code",
            "text": f"Your Great Minds sign-in code is: {code}\n\nExpires in {settings.auth_code_expiry_minutes} minutes.",
        }
    )
