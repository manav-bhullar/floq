const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Try to load Razorpay if it's installed
let Razorpay;
try {
  Razorpay = require('razorpay');
} catch (err) {
  console.error("Razorpay SDK is not installed yet. Run 'npm install razorpay' first.");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const envPath = path.join(__dirname, '..', '.env');

console.log('=========================================');
console.log('          Razorpay Secure Setup          ');
console.log('=========================================');
console.log('Your keys will be saved LOCALLY to your server/.env file.');
console.log('This file is ignored by Git, so your keys are safe.\n');

rl.question('Paste your RAZORPAY_KEY_ID: ', (keyIdInput) => {
  rl.question('Paste your RAZORPAY_KEY_SECRET: ', async (keySecretInput) => {
    const keyId = keyIdInput.trim();
    const keySecret = keySecretInput.trim();

    if (!keyId || !keySecret) {
      console.error('\n❌ Keys cannot be empty.');
      rl.close();
      return;
    }

    console.log('\n🔄 Verifying your keys with Razorpay...');
    try {
      const instance = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
      });

      // Try fetching a single order to verify credentials
      await instance.orders.all({ count: 1 });
      console.log('✅ Keys are valid and connected to Razorpay!');
    } catch (error) {
      console.error('❌ Failed to verify keys with Razorpay.');
      if (error.error && error.error.description) {
        console.error(`Reason: ${error.error.description}`);
      } else {
        console.error(error.message);
      }
      console.log('\nPlease check your keys and try again.');
      rl.close();
      return;
    }

    // Save to .env securely
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Remove old Razorpay keys if they exist
    const lines = envContent.split('\n').filter(line => !line.startsWith('RAZORPAY_'));
    
    // Append the new keys
    lines.push(`RAZORPAY_KEY_ID="${keyId}"`);
    lines.push(`RAZORPAY_KEY_SECRET="${keySecret}"`);

    // Write back to the file
    fs.writeFileSync(envPath, lines.join('\n').trim() + '\n');
    console.log(`\n🔒 Success! Your keys have been securely saved to:`);
    console.log(`   ${envPath}`);
    console.log(`\nYou are now ready for the payment integration!`);
    
    rl.close();
  });
});
