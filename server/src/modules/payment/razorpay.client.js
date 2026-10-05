const Razorpay = require('razorpay');

const getKeyId = () => process.env.RAZORPAY_KEY_ID || 'rzp_test_1DP5mmOlF5G5ag';
const getKeySecret = () => process.env.RAZORPAY_KEY_SECRET || 'testsecret_mock_12345';

let instance = null;

/**
 * Lazily initialize and return the Razorpay SDK instance
 */
function getRazorpayInstance() {
  const key_id = getKeyId();
  const key_secret = getKeySecret();
  
  if (!instance || instance.key_id !== key_id || instance.key_secret !== key_secret) {
    instance = new Razorpay({
      key_id,
      key_secret,
    });
  }
  return instance;
}

module.exports = {
  getRazorpayInstance,
  getKeyId,
  getKeySecret,
};
