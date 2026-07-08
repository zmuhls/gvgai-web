const express = require('express');
const { getAllModels } = require('../lib/models');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getAllModels());
});

module.exports = router;
