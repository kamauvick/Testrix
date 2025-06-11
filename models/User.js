const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true
      }
    },
    role: {
      type: DataTypes.ENUM('Admin', 'User', 'Manager'),
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('Active', 'Inactive'),
      allowNull: false
    }
  }, {
    timestamps: true
  });

  return User;
}; 