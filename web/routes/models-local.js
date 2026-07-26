const express = require('express');
const { getAllModels, isModelAvailable } = require('../lib/models');

const router = express.Router();

router.get('/', (req, res) => {
  // `available` is a serialization-time annotation (it depends on this
  // process's env), so the catalog itself stays pure for other consumers.
  res.json(getAllModels().map(model => ({
    ...model,
    available: isModelAvailable(model)
  })));
});

module.exports = router;
