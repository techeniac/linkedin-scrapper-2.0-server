# LinkedIn Scrapper Server

Production-ready TypeScript Node.js server for syncing LinkedIn profiles to HubSpot CRM.

## Features

- 🔐 JWT-based authentication
- 🔄 HubSpot OAuth integration
- 📊 LinkedIn to HubSpot contact/company sync
- 🛡️ Security with Helmet and rate limiting
- 📝 Request logging with Winston
- ✅ Input validation with express-validator
- 🗄️ PostgreSQL database with Prisma ORM

## Tech Stack

- **Runtime:** Node.js with TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL with Prisma
- **Authentication:** JWT + bcrypt
- **Logging:** Winston + Morgan
- **Validation:** express-validator

## Prerequisites

- Node.js 18+
- PostgreSQL database
- HubSpot developer account

## Setup

1. **Install dependencies:**

```bash
npm install
```

2. **Configure environment variables:**

cp .env.example .env

Edit .env with your credentials:
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX=100
LOG_LEVEL=info

# HubSpot OAuth

HUBSPOT_CLIENT_ID=your-client-id
HUBSPOT_CLIENT_SECRET=your-client-secret
HUBSPOT_REDIRECT_URI=http://localhost:3000/api/hubspot/callback
HUBSPOT_SCOPES=crm.objects.contacts.write crm.objects.contacts.read crm.objects.companies.write crm.objects.companies.read crm.objects.owners.read

3. **Run database migrations:**

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. **Start development server:**

```bash
npm run dev
```

Scripts :
npm run dev - Start development server with hot reload
npm run build - Build for production
npm start - Start production server
npm run prisma:generate - Generate Prisma client
npm run prisma:migrate - Run database migrations
npm run prisma:studio - Open Prisma Studio

API Endpoints :
Authentication :
POST /api/auth/register - Register new user
POST /api/auth/login - Login user
POST /api/auth/logout - Logout user
GET /api/auth/profile - Get user profile

    HubSpot Integration :
    GET /api/hubspot/connect - Get HubSpot OAuth URL
    GET /api/hubspot/callback - OAuth callback
    POST /api/hubspot/disconnect - Disconnect HubSpot
    GET /api/hubspot/status - Check connection status
    POST /api/hubspot/sync-lead - Sync LinkedIn lead to HubSpot
    GET /api/hubspot/check-profile - Check if profile exists in HubSpot

    Health
    GET /api/health - Health check

Project Structure

src/
├── config/ # Configuration files
├── controllers/ # Route controllers
├── middlewares/ # Express middlewares
├── models/ # Database models
├── routes/ # API routes
├── services/ # Business logic
├── types/ # TypeScript types
├── utils/ # Utility functions
├── app.ts # Express app setup
└── server.ts # Server entry point

License
ISC

```

```
