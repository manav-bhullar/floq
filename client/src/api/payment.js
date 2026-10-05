import { apiClient } from "./apiClient";

/**
 * Create a Razorpay payment order for the current user's trip fare share
 * 
 * @param {string|object} params - Trip ID string or payload object { tripId, tripUserId }
 * @returns {Promise<{ orderId: string, amount: number, currency: string, keyId: string, tripUserId: string, fareShare: number }>}
 */
export async function createPaymentOrder(params) {
  const body = typeof params === "string" ? { tripId: params } : params;
  const res = await apiClient.fetch("/payment/create-order", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.success) {
    throw {
      status: res.status,
      message: json.error?.message || "Failed to create payment order",
    };
  }
  return json.data;
}

/**
 * Cryptographically verify Razorpay payment HMAC signature on the backend
 * 
 * @param {object} data
 * @param {string} data.razorpayOrderId
 * @param {string} data.razorpayPaymentId
 * @param {string} data.razorpaySignature
 * @param {string} [data.tripUserId]
 * @returns {Promise<{ status: string, paymentId: string, tripUserId: string }>}
 */
export async function verifyPayment(data) {
  const res = await apiClient.fetch("/payment/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });

  const json = await res.json();
  if (!json.success) {
    throw {
      status: res.status,
      message: json.error?.message || "Payment verification failed",
    };
  }
  return json.data;
}

/**
 * Get payment status for a specific trip and current authenticated user
 * 
 * @param {string} tripId
 * @returns {Promise<{ isPaid: boolean, status: string | null, payment: object | null, fareShare: number, tripUserId: string }>}
 */
export async function getPaymentStatus(tripId) {
  const res = await apiClient.fetch(`/payment/status/${tripId}`);

  const json = await res.json();
  if (!json.success) {
    throw {
      status: res.status,
      message: json.error?.message || "Failed to fetch payment status",
    };
  }
  return json.data;
}
