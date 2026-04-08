import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/lib/auth";
import { loginWithCode, requestCode } from "@/api/client";
import LoginForm from "@/components/login-form";

type Step = "email" | "code";

export default function LoginContainer() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await requestCode(email);
      setStep("code");
    } catch {
      setError("Failed to send code. Check your email and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await loginWithCode(email, code);
      login();
      navigate("/");
    } catch {
      setError("Invalid or expired code.");
    } finally {
      setLoading(false);
    }
  }

  function handleBack() {
    setStep("email");
    setCode("");
    setError("");
  }

  return (
    <LoginForm
      step={step}
      email={email}
      code={code}
      error={error}
      loading={loading}
      onEmailChange={setEmail}
      onCodeChange={setCode}
      onRequestCode={handleRequestCode}
      onVerifyCode={handleVerifyCode}
      onBack={handleBack}
    />
  );
}
