function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }

  if (schema.type) {
    const actual = valueType(value);
    const valid = schema.type === 'number'
      ? actual === 'number' && Number.isFinite(value)
      : schema.type === 'integer'
        ? actual === 'number' && Number.isInteger(value)
        : actual === schema.type;
    if (!valid) {
      errors.push(`${path} must be ${schema.type}`);
      return;
    }
  }

  if (schema.type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateNode(item, properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }

  if (schema.type === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
  }

  if (['integer', 'number'].includes(schema.type)) {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} exceeds maximum`);
  }

  if (schema.type === 'string') {
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
  }
}

export function validateJsonSchema(value, schema) {
  const errors = [];
  validateNode(value, schema || {}, '$', errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
