<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    browserSupportsWebAuthn,
    browserSupportsWebAuthnAutofill,
    startAuthentication,
    WebAuthnAbortService,
  } from "@simplewebauthn/browser";
  import { onMount } from "svelte";

  import { api, run } from "$lib/api/app";
  import {
    loginWithCode,
    loginWithTokenPair,
    requestCode,
  } from "$lib/api/auth";
  import { auth } from "$lib/auth.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { Label } from "$lib/components/ui/label";

  type Step = "email" | "code";

  let step = $state<Step>("email");
  let email = $state("");
  let code = $state("");
  let error = $state("");
  let loading = $state(false);
  let passkeyLoading = $state(false);
  let passkeysSupported = $state(false);

  async function authenticateWithPasskey(
    useBrowserAutofill: boolean,
    shouldContinue: () => boolean = () => true,
  ): Promise<void> {
    const optionsJSON = await run(api.auth.passkeyAuthenticationOptions());
    if (!shouldContinue()) return;
    const response = await startAuthentication({
      optionsJSON,
      useBrowserAutofill,
    });
    const tokens = await run(api.auth.verifyPasskey({ payload: response }));
    await loginWithTokenPair(tokens);
    auth.login();
    await goto("/");
  }

  // Aborted conditional requests wedge Safari's WebAuthn state until reload.
  const isSafari = (() => {
    const agent = navigator.userAgent;
    return (
      agent.includes("Safari/") && !/Chrome\/|CriOS\/|Edg\/|Android/.test(agent)
    );
  })();

  onMount(() => {
    let active = true;
    passkeysSupported = browserSupportsWebAuthn();
    if (passkeysSupported && !isSafari) {
      void browserSupportsWebAuthnAutofill()
        .then((supported) => {
          if (!supported || !active) return;
          void authenticateWithPasskey(true, () => active).catch(
            (reason: unknown) => {
              console.warn("Conditional passkey sign-in ended", reason);
            },
          );
        })
        .catch((reason: unknown) => {
          console.warn("Conditional passkey sign-in ended", reason);
        });
    }
    return () => {
      active = false;
      WebAuthnAbortService.cancelCeremony();
    };
  });

  async function handleRequestCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = "";
    loading = true;
    try {
      await requestCode(email);
      if (import.meta.env.VITE_SUPPRESS_AUTH) {
        await loginWithCode(email, "000000");
        auth.login();
        await goto("/");
      } else {
        step = "code";
      }
    } catch {
      error = "Failed to send code. Check your email and try again.";
    } finally {
      loading = false;
    }
  }

  async function handleVerifyCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = "";
    loading = true;
    try {
      await loginWithCode(email, code);
      auth.login();
      await goto("/");
    } catch {
      error = "Invalid or expired code.";
    } finally {
      loading = false;
    }
  }

  function handleBack(): void {
    step = "email";
    code = "";
    error = "";
  }

  async function handlePasskeySignIn(): Promise<void> {
    if (passkeyLoading) return;
    passkeyLoading = true;
    try {
      await authenticateWithPasskey(false);
    } catch (reason) {
      console.warn("Passkey sign-in ended", reason);
    } finally {
      passkeyLoading = false;
    }
  }
</script>

<div class="flex h-screen items-center justify-center bg-ink">
  <div class="w-full max-w-sm space-y-8 px-6">
    <div class="text-center">
      <h1 class="font-serif text-title text-warm">Great Minds</h1>
      <p class="mt-2 text-small text-warm-faint">
        {step === "email"
          ? "Enter your email to sign in"
          : `Code sent to ${email}`}
      </p>
    </div>

    {#if error}
      <Alert
        variant="destructive"
        class="rounded-sm border-red-400/25 bg-red-400/5"
      >
        <AlertDescription class="text-center text-small text-red-400/90">
          {error}
        </AlertDescription>
      </Alert>
    {/if}

    {#if step === "email"}
      <form onsubmit={handleRequestCode} class="space-y-4">
        <Label for="login-email" class="sr-only">Email address</Label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="login-email"
          type="email"
          bind:value={email}
          placeholder="you@example.com"
          required
          autofocus
          autocomplete="username webauthn"
          class="w-full rounded-sm border border-ink-border bg-ink-raised px-4 py-3 font-mono text-small text-warm placeholder:text-warm-ghost outline-none focus:border-gold-dim"
        />
        <button
          type="submit"
          disabled={loading}
          class="w-full rounded-sm bg-gold px-4 py-3 font-mono text-small text-primary-foreground font-semibold hover:bg-gold-hover disabled:opacity-50 transition-colors"
        >
          {loading ? "Sending..." : "Send code"}
        </button>
      </form>
      {#if passkeysSupported}
        <button
          type="button"
          onclick={() => void handlePasskeySignIn()}
          disabled={passkeyLoading}
          class="mt-4 w-full py-2 text-center font-mono text-caption tracking-[0.04em] text-warm-faint transition-colors hover:text-warm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-50"
        >
          {passkeyLoading ? "waiting for passkey…" : "sign in with a passkey"}
        </button>
      {/if}
    {:else}
      <form onsubmit={handleVerifyCode} class="space-y-4">
        <Label for="login-code" class="sr-only">Verification code</Label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="login-code"
          type="text"
          bind:value={code}
          placeholder="6-digit code"
          required
          autofocus
          maxlength={6}
          inputmode="numeric"
          pattern="[0-9]*"
          class="w-full rounded-sm border border-ink-border bg-ink-raised px-4 py-3 font-mono text-small text-warm text-center tracking-[0.5em] placeholder:tracking-normal placeholder:text-warm-ghost outline-none focus:border-gold-dim"
        />
        <button
          type="submit"
          disabled={loading}
          class="w-full rounded-sm bg-gold px-4 py-3 font-mono text-small text-primary-foreground font-semibold hover:bg-gold-hover disabled:opacity-50 transition-colors"
        >
          {loading ? "Verifying..." : "Sign in"}
        </button>
        <button
          type="button"
          onclick={handleBack}
          class="w-full text-center text-caption text-warm-faint hover:text-warm transition-colors"
        >
          Use a different email
        </button>
      </form>
    {/if}
  </div>
</div>
