import { useState, useRef, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./AuthPages.css";

export default function VerifyEmailPage() {
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);

  const { verify, resendVerification } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const email = location.state?.email;
  const inputRefs = useRef([]);

  useEffect(() => {
    if (!email) {
      navigate("/login");
    }
  }, [email, navigate]);

  useEffect(() => {
    let timer;
    if (countdown > 0) {
      timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleChange = (index, value) => {
    if (isNaN(value)) return;

    const newOtp = [...otp];
    // Allow pasting full code
    if (value.length > 1) {
      const pasted = value.slice(0, 6).split("");
      pasted.forEach((char, i) => {
        if (index + i < 6) newOtp[index + i] = char;
      });
      setOtp(newOtp);
      // Focus last filled or next empty
      const nextIndex = Math.min(index + pasted.length, 5);
      inputRefs.current[nextIndex]?.focus();
      return;
    }

    newOtp[index] = value;
    setOtp(newOtp);

    // Auto focus next
    if (value !== "" && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      // Focus previous on backspace if current is empty
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const otpString = otp.join("");

    if (otpString.length !== 6) {
      return setError("Please enter the 6-digit code");
    }

    setError("");
    setLoading(true);

    try {
      await verify(email, otpString);
      navigate("/home", { replace: true });
    } catch (err) {
      setError(err.message || "Verification failed. Please check the code.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;

    setError("");
    setResendLoading(true);
    try {
      await resendVerification(email);
      setCountdown(60);
      setOtp(["", "", "", "", "", ""]); // Clear inputs
      inputRefs.current[0]?.focus();
    } catch (err) {
      setError(err.message || "Failed to resend code");
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="auth-screen-expressive">
      <div className="blur-shape auth-blur-1"></div>
      <div className="blur-shape auth-blur-2"></div>

      <div className="auth-content-layer">
        <div className="auth-card glass-card">
          <div className="auth-header">
            <h1>Verify Email</h1>
            <p>
              We sent a 6-digit code to
              <br />
              <strong>{email}</strong>
            </p>
          </div>

          {error && <div className="auth-error" role="alert" aria-live="assertive">{error}</div>}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="otp-container">
              {otp.map((digit, index) => (
                <input
                  key={index}
                  type="text"
                  inputMode="numeric"
                  maxLength="6"
                  value={digit}
                  ref={(el) => (inputRefs.current[index] = el)}
                  onChange={(e) => handleChange(index, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  className="otp-input"
                  disabled={loading}
                  aria-label={`Digit ${index + 1} of 6`}
                />
              ))}
            </div>

            <button
              type="submit"
              className={`auth-submit-btn ${loading ? "loading" : ""}`}
              disabled={loading || otp.join("").length !== 6}
            >
              {loading ? "Verifying..." : "Verify Email"}
            </button>
          </form>

          <div className="auth-footer verify-footer">
            <p>Didn't receive the code?</p>
            <button
              type="button"
              className="resend-btn"
              onClick={handleResend}
              disabled={countdown > 0 || resendLoading}
            >
              {resendLoading
                ? "Sending..."
                : countdown > 0
                  ? `Resend code in ${countdown}s`
                  : "Resend Code"}
            </button>

            <div className="back-to-login">
              <Link to="/login">Back to Login</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
