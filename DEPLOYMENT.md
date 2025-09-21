# SQLite Recovery Tool - Deployment Guide

## 🚀 Deploying to Coolify

This guide will help you deploy the SQLite Recovery Tool to Coolify, a self-hosted alternative to Heroku/Netlify.

### Prerequisites

- Coolify instance running
- Git repository with this code
- Docker support enabled on Coolify

### Deployment Steps

#### 1. **Prepare Your Repository**

Make sure your repository contains all the necessary files:
- `Dockerfile` ✅
- `docker-compose.yml` ✅
- `coolify.json` ✅
- `.dockerignore` ✅
- All application files ✅

#### 2. **Deploy via Coolify Dashboard**

1. **Create New Application**
   - Go to your Coolify dashboard
   - Click "New Application"
   - Choose "Docker" as the deployment type

2. **Configure Repository**
   - Connect your Git repository
   - Set branch to `main` or your preferred branch
   - Coolify will auto-detect the Dockerfile

3. **Environment Variables** (Optional)
   ```
   NODE_ENV=production
   PORT=5000
   ```

4. **Port Configuration**
   - Set application port to `5000`
   - Coolify will automatically handle external port mapping

5. **Volume Configuration** (Recommended)
   - Create a persistent volume for uploads
   - Mount point: `/app/uploads`
   - This ensures uploaded files persist across deployments

#### 3. **Deploy**

Click "Deploy" and Coolify will:
1. Clone your repository
2. Build the Docker image
3. Start the container
4. Provide you with a public URL

### Configuration Files Explained

#### `Dockerfile`
- Uses Node.js 20 Alpine for smaller image size
- Installs full SQLite3 (not Android SDK version)
- Sets up proper permissions and health checks
- Optimized for production deployment

#### `coolify.json`
- Coolify-specific configuration
- Defines health check endpoints
- Sets up volume mounts
- Configures environment variables

#### `docker-compose.yml`
- For local testing before deployment
- Mirrors production configuration
- Useful for development and testing

### Health Check

The application includes a health check endpoint at `/api/health` that:
- Returns JSON status
- Includes timestamp
- Used by Coolify to monitor application health
- Accessible on port 5000

### Features in Production

✅ **Full SQLite3 Support**: Uses complete SQLite installation with `.recover` command
✅ **File Upload Handling**: Supports up to 100MB file uploads
✅ **ZIP File Processing**: Handles corrupted ZIP files with CRC errors
✅ **Multiple Recovery Methods**: Falls back to alternative methods if needed
✅ **Automatic Cleanup**: Cleans up temporary files after processing
✅ **Error Handling**: Comprehensive error handling and logging
✅ **Security**: Proper file validation and sanitization

### Testing Your Deployment

1. **Access the Application**
   - Use the URL provided by Coolify
   - Should see the SQLite Recovery Tool interface

2. **Test File Upload**
   - Upload a small SQLite database or ZIP file
   - Verify the recovery process works

3. **Check Logs**
   - Monitor Coolify logs for any issues
   - Look for SQLite version detection messages

### Troubleshooting

#### Common Issues

1. **Port Issues**
   - Ensure port 5000 is configured in Coolify
   - Check that the application is binding to `0.0.0.0:5000`

2. **File Upload Issues**
   - Verify volume mounts are configured
   - Check file size limits (default: 100MB)

3. **SQLite Issues**
   - Check logs for SQLite version detection
   - Ensure Alpine SQLite package is installed correctly

#### Logs to Check

```bash
# In Coolify logs, look for:
✅ SQLite 3.x.x is available with .recover support
SQLite Recovery Server running on port 5000
Environment: production
Server is ready to accept connections
```

### Scaling Considerations

- **File Storage**: Use persistent volumes for uploads directory
- **Memory**: Adjust container memory based on file sizes you expect
- **CPU**: SQLite recovery can be CPU-intensive for large databases
- **Cleanup**: Files are automatically cleaned up, but monitor disk usage

### Security Notes

- Files are temporarily stored during processing
- Automatic cleanup prevents disk space issues
- File type validation prevents malicious uploads
- No sensitive data is logged

### Support

If you encounter issues:
1. Check Coolify logs
2. Verify all configuration files are present
3. Test locally with `docker-compose up`
4. Ensure your Git repository is accessible to Coolify

---

## 🐳 Local Docker Testing

Before deploying to Coolify, test locally:

```bash
# Build and run with Docker Compose
docker-compose up --build

# Or build and run manually
docker build -t sqlite-recovery .
docker run -p 5000:5000 sqlite-recovery
```

Access at `http://localhost:5000`

---

## 📝 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `5000` | Server port |

---

Your SQLite Recovery Tool is now ready for production deployment on Coolify! 🎉
