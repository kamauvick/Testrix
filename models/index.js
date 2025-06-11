const { Sequelize } = require('sequelize');
const path = require('path');

console.log('Initializing Sequelize...');
// Initialize Sequelize with SQLite
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, '../database.sqlite'),
  logging: console.log // Enable logging
});

// Import model definitions
const UserModel = require('./User');
const ProjectModel = require('./Project');
const ApiKeyModel = require('./ApiKey');
const TestRunModel = require('./TestRun');
const TestCaseModel = require('./TestCase');

// Initialize models
console.log('Initializing models...');
const User = UserModel(sequelize);
const Project = ProjectModel(sequelize);
const ApiKey = ApiKeyModel(sequelize);
const TestRun = TestRunModel(sequelize);
const TestCase = TestCaseModel(sequelize);

// Set up associations
const setupAssociations = () => {
  console.log('Setting up model associations...');
  User.hasMany(ApiKey, { foreignKey: 'userId' });
  ApiKey.belongsTo(User, { foreignKey: 'userId' });

  User.hasMany(TestRun, { foreignKey: 'userId' });
  TestRun.belongsTo(User, { foreignKey: 'userId' });

  Project.hasMany(TestRun, { foreignKey: 'projectId' });
  TestRun.belongsTo(Project, { foreignKey: 'projectId' });

  TestRun.hasMany(TestCase, { foreignKey: 'testRunId' });
  TestCase.belongsTo(TestRun, { foreignKey: 'testRunId' });
};

// Initialize database
const initDatabase = async () => {
  try {
    console.log('Attempting to authenticate database connection...');
    await sequelize.authenticate();
    console.log('Database connection established successfully.');
    
    // Set up associations
    setupAssociations();
    
    // Sync all models
    console.log('Synchronizing database models...');
    await sequelize.sync({ force: false }); // Don't force recreate tables
    console.log('Database synchronized successfully.');
  } catch (error) {
    console.error('Database initialization error:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
};

// Call initDatabase immediately
initDatabase().catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});

module.exports = {
  sequelize,
  User,
  Project,
  ApiKey,
  TestRun,
  TestCase,
  initDatabase
}; 