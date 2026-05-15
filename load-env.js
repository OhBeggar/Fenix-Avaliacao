const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  
  envContent.split('\n').forEach((line) => {
    const trimmedLine = line.trim();
    
    // Ignora linhas vazias e comentários
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      return;
    }
    
    const [key, ...valueParts] = trimmedLine.split('=');
    const value = valueParts.join('=').trim();
    
    if (key && value && process.env[key.trim()] === undefined) {
      process.env[key.trim()] = value;
    }
  });
  
  console.log('✓ Variáveis de ambiente carregadas do .env');
}
