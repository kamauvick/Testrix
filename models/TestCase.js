const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TestCase = sequelize.define('TestCase', {
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
      type: DataTypes.ENUM('Passed', 'Failed', 'Skipped'),
      allowNull: false
    },
    duration: {
      type: DataTypes.INTEGER, // Duration in milliseconds
      allowNull: true
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    errorStack: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    screenshot: {
      type: DataTypes.STRING, // Path to screenshot file
      allowNull: true
    },
    video: {
      type: DataTypes.STRING, // Path to video file
      allowNull: true
    },
    trace: {
      type: DataTypes.STRING, // Path to trace file
      allowNull: true
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    suite: {
      type: DataTypes.STRING,
      allowNull: true
    },
    file: {
      type: DataTypes.STRING,
      allowNull: true
    },
    line: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    timestamps: true
  });

  return TestCase;
}; 