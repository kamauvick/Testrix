const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TestRun = sequelize.define('TestRun', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('running', 'passed', 'failed'),
      allowNull: false
    },
    startTime: {
      type: DataTypes.DATE,
      allowNull: false
    },
    endTime: {
      type: DataTypes.DATE,
      allowNull: true
    },
    totalTests: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    passedTests: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    failedTests: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    skippedTests: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    totalDuration: {
      type: DataTypes.FLOAT,
      defaultValue: 0
    },
    environment: {
      type: DataTypes.STRING,
      allowNull: true
    },
    branch: {
      type: DataTypes.STRING,
      allowNull: true
    },
    commit: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    timestamps: true
  });

  return TestRun;
}; 