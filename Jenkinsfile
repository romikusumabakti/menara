pipeline {
    agent any

    environment {
        POSTGRES_PASSWORD  = credentials('menara-postgres-password')
        BETTER_AUTH_SECRET = credentials('menara-better-auth-secret')
        RESEND_API_KEY     = credentials('menara-resend-api-key')
    }

    stages {
        stage('Deploy') {
            steps {
                sh "docker compose up -d --build"
            }
        }
    }
}
