interface LoginFormProps {
  step: "email" | "code";
  email: string;
  code: string;
  error: string;
  loading: boolean;
  onEmailChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onRequestCode: (e: React.FormEvent) => void;
  onVerifyCode: (e: React.FormEvent) => void;
  onBack: () => void;
}

export default function LoginForm({
  step,
  email,
  code,
  error,
  loading,
  onEmailChange,
  onCodeChange,
  onRequestCode,
  onVerifyCode,
  onBack,
}: LoginFormProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-ink">
      <div className="w-full max-w-sm space-y-8 px-6">
        <div className="text-center">
          <h1 className="font-serif text-title text-warm">Great Minds</h1>
          <p className="mt-2 text-small text-warm-faint">
            {step === "email" ? "Enter your email to sign in" : `Code sent to ${email}`}
          </p>
        </div>

        {error && <p className="text-center text-small text-destructive">{error}</p>}

        {step === "email" ? (
          <form onSubmit={onRequestCode} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
              className="w-full rounded-sm border border-ink-border bg-ink-raised px-4 py-3 font-mono text-small text-warm placeholder:text-warm-ghost outline-none focus:border-gold-dim"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-sm bg-gold px-4 py-3 font-mono text-small text-primary-foreground font-semibold hover:bg-gold-hover disabled:opacity-50 transition-colors"
            >
              {loading ? "Sending..." : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={onVerifyCode} className="space-y-4">
            <input
              type="text"
              value={code}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="6-digit code"
              required
              autoFocus
              maxLength={6}
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-sm border border-ink-border bg-ink-raised px-4 py-3 font-mono text-small text-warm text-center tracking-[0.5em] placeholder:tracking-normal placeholder:text-warm-ghost outline-none focus:border-gold-dim"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-sm bg-gold px-4 py-3 font-mono text-small text-primary-foreground font-semibold hover:bg-gold-hover disabled:opacity-50 transition-colors"
            >
              {loading ? "Verifying..." : "Sign in"}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="w-full text-center text-caption text-warm-faint hover:text-warm transition-colors"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
