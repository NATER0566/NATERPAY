# NATER-PAY Enterprise Fintech Platform

A complete, production-ready fintech services platform with authentication, KYC, VTU, payment processing, merchant services, and real-time systems.

## Features

- **Authentication**: JWT tokens, refresh tokens, OTP verification
- **KYC System**: Multi-level verification (BVN/NIN, ID documents, address)
- **VTU Services**: Airtime, data, electricity, cable TV subscriptions
- **Payment Processing**: Paystack, Flutterwave, Monnify integration
- **Wallet System**: Secure balance management with Decimal128
- **Merchant Services**: Payment links, invoices, QR codes
- **Security**: Device tracking, withdrawal PIN, fraud monitoring
- **Real-time**: Socket.io for live updates
- **Admin Panel**: Full administrative controls
- **CMS**: Dynamic content management
- **API System**: Developer API with key management
- **Audit & Notifications**: Complete audit logging and notification system

## Tech Stack

- **Backend**: Node.js 20, Fastify
- **Database**: MongoDB Atlas with Mongoose
- **Authentication**: JWT, bcryptjs
- **Real-time**: Socket.io
- **Cron Jobs**: node-cron
- **Security**: Helmet, CORS, rate limiting
- **VTU Providers**: VTpass, VTUGate
- **Payment Providers**: Paystack, Flutterwave, Monnify

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd naterpay
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# MongoDB
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/naterpay

# JWT
JWT_SECRET=your_jwt_secret_key
JWT_REFRESH_SECRET=your_refresh_secret_key
JWT_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d

# Payment Providers
PAYSTACK_SECRET_KEY=your_paystack_secret
PAYSTACK_PUBLIC_KEY=your_paystack_public
FLUTTERWAVE_SECRET_KEY=your_flutterwave_secret
FLUTTERWAVE_PUBLIC_KEY=your_flutterwave_public
MONNIFY_SECRET_KEY=your_monnify_secret
MONNIFY_PUBLIC_KEY=your_monnify_public
MONNIFY_API_KEY=your_monnify_api_key
MONNIFY_CONTRACT_CODE=your_contract_code

# VTU Providers
VTPASS_USERNAME=your_vtpass_username
VTPASS_PASSWORD=your_vtpass_password
VTPASS_PUBLIC_KEY=your_vtpass_public_key
VTUGATE_API_KEY=your_vtugate_api_key

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASS=your_password
EMAIL_FROM=noreply@naterpay.com

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# SMS
SMS_API_KEY=your_sms_api_key
SMS_SENDER_ID=NATERPAY

# Feature Flags
FEATURE_WALLET=true
FEATURE_LOANS=false
FEATURE_SAVINGS=false
FEATURE_ESCROW=false
FEATURE_VIRTUAL_CARDS=false
FEATURE_AGENT_BANKING=false
FEATURE_TASK_EARN=false
FEATURE_DAILY_REWARDS=false
FEATURE_SPIN_WIN=false
FEATURE_AIRTIME_CASH=false

# Security
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_DURATION=30
SESSION_TIMEOUT=30
IP_WHITELIST=

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=900000

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Admin
ADMIN_EMAIL=admin@naterpay.com

# Business
MIN_WITHDRAWAL=1000
MAX_WITHDRAWAL=500000
DEFAULT_REFERRAL_BONUS=100

# Cron Jobs
CRON_RECONCILIATION=0 */6 * * *
CRON_ANALYTICS=0 0 * * *
CRON_BACKUP=0 2 * * *
```

## Running the Application

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

### Seed Database
```bash
npm run seed
```

### Run Tests
```bash
npm test
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/verify-otp` - Verify OTP for registration
- `POST /api/auth/login` - Login user
- `POST /api/auth/refresh-token` - Refresh access token
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password with OTP
- `GET /api/auth/profile` - Get user profile (authenticated)
- `POST /api/auth/logout` - Logout user (authenticated)

### User
- `GET /api/user/dashboard-data` - Get dashboard data (authenticated)
- `POST /api/user/dashboard-preferences` - Update preferences (authenticated)
- `POST /api/user/profile` - Update profile (authenticated)
- `GET /api/user/referral-tree` - Get referral tree (authenticated)

### Wallet
- `GET /api/wallet` - Get wallet (authenticated)
- `POST /api/wallet/fund` - Fund wallet (authenticated)
- `POST /api/wallet/withdraw` - Withdraw from wallet (authenticated)
- `POST /api/wallet/transfer` - Transfer to another user (authenticated)
- `POST /api/wallet/set-pin` - Set withdrawal PIN (authenticated)

### VTU
- `POST /api/vtu/airtime` - Buy airtime (authenticated)
- `POST /api/vtu/data` - Buy data (authenticated)
- `POST /api/vtu/electricity` - Buy electricity (authenticated)
- `POST /api/vtu/cable` - Buy cable TV subscription (authenticated)
- `GET /api/vtu/rates` - Get VTU rates (public)

### Transactions
- `GET /api/transactions` - Get user transactions (authenticated)
- `GET /api/transactions/:id` - Get single transaction (authenticated)

### KYC
- `GET /api/kyc` - Get KYC status (authenticated)
- `POST /api/kyc/level1` - Submit Level 1 KYC (authenticated)
- `POST /api/kyc/level2` - Submit Level 2 KYC (authenticated)
- `POST /api/kyc/level3` - Submit Level 3 KYC (authenticated)

### Payment Links
- `GET /api/payment-links` - Get user's payment links (authenticated)
- `POST /api/payment-links` - Create payment link (authenticated)
- `GET /api/payment-links/:linkId` - Get payment link (public)
- `POST /api/payment-links/:linkId/pay` - Pay payment link (public)

### Invoices
- `GET /api/invoices` - Get user's invoices (authenticated)
- `POST /api/invoices` - Create invoice (authenticated)
- `GET /api/invoices/:invoiceId` - Get invoice (public)
- `POST /api/invoices/:invoiceId/pay` - Pay invoice (public)

### Notifications
- `GET /api/notifications` - Get user notifications (authenticated)
- `PUT /api/notifications/:id/read` - Mark notification as read (authenticated)
- `PUT /api/notifications/read-all` - Mark all notifications as read (authenticated)

### Support
- `GET /api/support/tickets` - Get user's support tickets (authenticated)
- `POST /api/support/tickets` - Create support ticket (authenticated)
- `GET /api/support/tickets/:ticketId` - Get ticket details (authenticated)
- `POST /api/support/tickets/:ticketId/messages` - Add message to ticket (authenticated)

### Admin
- `GET /api/admin/users` - Get all users (admin)
- `GET /api/admin/users/:id` - Get single user (admin)
- `PUT /api/admin/users/:id` - Update user (admin)
- `GET /api/admin/transactions` - Get all transactions (admin)
- `GET /api/admin/analytics` - Get analytics (admin)
- `GET /api/admin/kyc/pending` - Get pending KYC requests (admin)
- `PUT /api/admin/kyc/:id/approve` - Approve KYC (admin)
- `PUT /api/admin/kyc/:id/reject` - Reject KYC (admin)
- `GET /api/admin/support/tickets` - Get support tickets (admin)
- `PUT /api/admin/support/tickets/:id/assign` - Assign ticket (admin)
- `PUT /api/admin/support/tickets/:id/resolve` - Resolve ticket (admin)

### CMS
- `GET /api/cms/homepage-data` - Get homepage data (public)
- `GET /api/slides` - Get slides (public)
- `PUT /api/cms/homepage` - Update homepage (admin)
- `POST /api/cms/slides` - Add slide (admin)
- `PUT /api/cms/slides/:id` - Update slide (admin)
- `DELETE /api/cms/slides/:id` - Delete slide (admin)
- `GET /api/cms/announcements` - Get announcements (public)
- `POST /api/cms/announcements` - Add announcement (admin)
- `PUT /api/cms/announcements/:id` - Update announcement (admin)
- `DELETE /api/cms/announcements/:id` - Delete announcement (admin)
- `PUT /api/cms/maintenance` - Set maintenance mode (admin)

### Developer API
- `GET /api/api/keys` - Get API keys (authenticated)
- `POST /api/api/keys` - Generate API key (authenticated)
- `DELETE /api/api/keys` - Revoke API key (authenticated)
- `GET /api/api/balance` - Get balance (API key auth)
- `POST /api/api/transactions` - Create transaction (API key auth)

## Database Models

- **User**: User accounts with authentication, KYC, wallet, referral, reseller, merchant, security, OTP, API keys
- **Transaction**: Transaction records with types, amounts, status, provider info, idempotency, fraud flags
- **Wallet**: Wallet balances, daily limits, PIN, status
- **KYC**: Multi-level verification records
- **Device**: Device/session tracking
- **PaymentLink**: Payment links for collections
- **Invoice**: Invoice management
- **Notification**: User notifications
- **AuditLog**: System audit trail
- **SupportTicket**: Support ticket system
- **CMS**: Content management system
- **Analytics**: Platform analytics

## Security Features

- JWT authentication with refresh tokens
- OTP verification for sensitive operations
- Device and session tracking
- Withdrawal PIN protection
- Rate limiting and brute force prevention
- IP whitelisting support
- Account lockout after failed attempts
- Audit logging for all actions
- Idempotency protection for transactions
- Webhook validation

## Money Safety

- MongoDB Decimal128 for precise financial calculations
- Transaction-based operations with rollback support
- Idempotency keys for duplicate request prevention
- Automated reconciliation system
- Audit trail for all financial operations
- Daily transaction limits
- Wallet freeze functionality

## Deployment

### Render.com
The platform is configured for deployment on Render.com using the provided `render.yaml` file.

1. Connect your GitHub repository to Render
2. Select "Web Service"
3. Use the `render.yaml` configuration
4. Set environment variables in Render dashboard
5. Deploy

### Environment Variables Required
- `MONGODB_URI` - MongoDB connection string
- `JWT_SECRET` - JWT secret key
- `JWT_REFRESH_SECRET` - JWT refresh secret
- Payment provider API keys (Paystack, Flutterwave, Monnify)
- VTU provider credentials (VTpass, VTUGate)
- Email and SMS provider credentials

## Cron Jobs

The platform includes automated cron jobs:
- **Reconciliation**: Runs every 6 hours to reconcile pending transactions
- **Analytics Recording**: Runs daily at midnight
- **Backup**: Runs daily at 2 AM
- **Overdue Invoice Check**: Runs daily at 9 AM

## Feature Flags

The platform uses feature flags to control feature availability:
- `FEATURE_WALLET` - Enable/disable wallet features
- `FEATURE_LOANS` - Enable/disable loan features
- `FEATURE_SAVINGS` - Enable/disable savings features
- `FEATURE_ESCROW` - Enable/disable escrow features
- `FEATURE_VIRTUAL_CARDS` - Enable/disable virtual card features
- `FEATURE_AGENT_BANKING` - Enable/disable agent banking
- `FEATURE_TASK_EARN` - Enable/disable task and earn
- `FEATURE_DAILY_REWARDS` - Enable/disable daily rewards
- `FEATURE_SPIN_WIN` - Enable/disable spin and win
- `FEATURE_AIRTIME_CASH` - Enable/disable airtime to cash

## Support

For support, contact:
- Email: nmbashau@gmail.com
- WhatsApp: +2348160979620

## License

Proprietary - All rights reserved

## Version

v3.0 - Enterprise Production Release
