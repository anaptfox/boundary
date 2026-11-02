use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::{ProgramError, ProgramErrorCode, canonical::normalize_value, canonical_json};

mod instance;
mod keywords;
mod pattern;

use keywords::{
    alternatives, compile_additional, compile_enum, compile_items, compile_properties, count,
    finite_number, optional_bool, optional_node, optional_type, string_set, validate_order,
};
use pattern::{CachedRegex, optional_pattern};

const KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems",
    "propertyNames",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A JSON value category supported by the Program v1 schema profile.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaType {
    /// The JSON null value.
    Null,
    /// A JSON boolean.
    Boolean,
    /// A JSON object.
    Object,
    /// A JSON array.
    Array,
    /// Any finite JSON number.
    Number,
    /// A finite integral JSON number.
    Integer,
    /// A JSON string.
    String,
}

/// A validated, owned AST for Program v1's bounded JSON Schema profile.
#[derive(Clone, Debug)]
pub struct PortableSchema {
    root: Value,
    ast: SchemaAst,
}

impl PortableSchema {
    /// Validates and normalizes a schema value.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] for non-portable JSON, unsupported keywords, or
    /// malformed keyword values.
    pub fn from_value(value: Value) -> Result<Self, ProgramError> {
        let root = normalize_value(value)?;
        let ast = compile_node(&root, "schema")?;
        Ok(Self { root, ast })
    }

    /// Parses JSON while rejecting duplicate object keys before validation.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] for invalid JSON, duplicate keys, or a schema
    /// outside Program v1.
    pub fn from_json_str(source: &str) -> Result<Self, ProgramError> {
        Self::from_value(super::canonical::parse_strict_json(source)?)
    }

    /// Returns a schema that accepts every portable JSON value.
    #[must_use]
    pub fn any() -> Self {
        Self {
            root: Value::Object(serde_json::Map::new()),
            ast: SchemaAst::default(),
        }
    }

    /// Returns a schema constrained to one JSON value category.
    #[must_use]
    pub fn of_type(schema_type: SchemaType) -> Self {
        let name = match schema_type {
            SchemaType::Null => "null",
            SchemaType::Boolean => "boolean",
            SchemaType::Object => "object",
            SchemaType::Array => "array",
            SchemaType::Number => "number",
            SchemaType::Integer => "integer",
            SchemaType::String => "string",
        };
        let mut object = serde_json::Map::new();
        object.insert("type".to_owned(), Value::String(name.to_owned()));
        Self {
            root: Value::Object(object),
            ast: SchemaAst {
                schema_type: Some(schema_type),
                ..SchemaAst::default()
            },
        }
    }

    /// Generates and lowers a Rust type's schema, failing closed when Schemars
    /// emits semantics outside the bounded profile.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError`] when generation fails, a reference is recursive
    /// or external, or emitted assertions are outside Program v1.
    #[cfg(feature = "schemars")]
    pub fn for_type<T: schemars::JsonSchema>() -> Result<Self, ProgramError> {
        let generated = schemars::schema_for!(T);
        let root = serde_json::to_value(generated).map_err(|error| {
            schema_error("schema", format!("Schemars serialization failed: {error}"))
        })?;
        let lowered = super::schema_schemars::lower_schemars(&root)?;
        Self::from_value(lowered)
    }

    /// Returns the normalized JSON representation used by contracts.
    #[must_use]
    pub fn as_value(&self) -> &Value {
        &self.root
    }

    /// Returns whether one portable JSON value satisfies this compiled schema.
    ///
    /// The check uses the same validated AST as contract compilation and
    /// compatibility; callers do not interpret raw schema JSON independently.
    #[must_use]
    pub fn accepts(&self, value: &Value) -> bool {
        instance::accepts(&self.ast, value)
    }

    pub(crate) fn ast(&self) -> &SchemaAst {
        &self.ast
    }
}

impl PartialEq for PortableSchema {
    fn eq(&self, other: &Self) -> bool {
        self.root == other.root
    }
}

impl Serialize for PortableSchema {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.root.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PortableSchema {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SchemaAst {
    pub(crate) schema_type: Option<SchemaType>,
    pub(crate) properties: BTreeMap<String, SchemaAst>,
    pub(crate) required: BTreeSet<String>,
    pub(crate) additional: Option<AdditionalProperties>,
    pub(crate) items: Option<Items>,
    pub(crate) prefix_items: Vec<SchemaAst>,
    pub(crate) property_names: Option<Box<SchemaAst>>,
    pub(crate) enumeration: Option<Vec<Value>>,
    pub(crate) constant: Option<Value>,
    pub(crate) any_of: Vec<SchemaAst>,
    pub(crate) one_of: Vec<SchemaAst>,
    pub(crate) all_of: Vec<SchemaAst>,
    pub(crate) not: Option<Box<SchemaAst>>,
    pub(crate) minimum: Option<f64>,
    pub(crate) maximum: Option<f64>,
    pub(crate) exclusive_minimum: Option<f64>,
    pub(crate) exclusive_maximum: Option<f64>,
    pub(crate) min_length: Option<u64>,
    pub(crate) max_length: Option<u64>,
    pub(crate) pattern: Option<String>,
    pub(crate) pattern_regex: Option<CachedRegex>,
    pub(crate) min_items: Option<u64>,
    pub(crate) max_items: Option<u64>,
    pub(crate) unique_items: Option<bool>,
}

impl SchemaAst {
    /// Evaluates one value against this validated node.
    pub(crate) fn accepts(&self, value: &Value) -> bool {
        instance::accepts(self, value)
    }
}

/// `items` in the profile: a schema for every later position, or `false`
/// closing a tuple after `prefixItems`. `items: true` is not portable.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Items {
    Forbidden,
    Schema(Box<SchemaAst>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AdditionalProperties {
    Allowed(bool),
    Schema(Box<SchemaAst>),
}

fn compile_node(value: &Value, path: &str) -> Result<SchemaAst, ProgramError> {
    let object = value
        .as_object()
        .ok_or_else(|| schema_error(path, "schema nodes must be JSON objects"))?;
    for keyword in object.keys() {
        if !KEYWORDS.contains(&keyword.as_str()) {
            return Err(ProgramError::new(
                ProgramErrorCode::UnsupportedSchema,
                format!("{path}.{keyword}"),
                format!("`{keyword}` is outside the portable schema profile"),
            ));
        }
    }

    let schema_type = optional_type(object.get("type"), &format!("{path}.type"))?;
    let properties = compile_properties(object.get("properties"), path)?;
    let required = string_set(object.get("required"), &format!("{path}.required"))?;
    let additional = compile_additional(object.get("additionalProperties"), path)?;
    let items = compile_items(object.get("items"), &format!("{path}.items"))?;
    let prefix_items = alternatives(
        object.get("prefixItems"),
        &format!("{path}.prefixItems"),
        "prefixItems",
    )?;
    let property_names = optional_node(
        object.get("propertyNames"),
        &format!("{path}.propertyNames"),
    )?;
    let enumeration = compile_enum(object.get("enum"), &format!("{path}.enum"))?;
    let constant = object.get("const").cloned();
    let any_of = alternatives(object.get("anyOf"), &format!("{path}.anyOf"), "anyOf")?;
    let one_of = alternatives(object.get("oneOf"), &format!("{path}.oneOf"), "oneOf")?;
    let all_of = alternatives(object.get("allOf"), &format!("{path}.allOf"), "allOf")?;
    let not = optional_node(object.get("not"), &format!("{path}.not"))?;
    let minimum = finite_number(object.get("minimum"), &format!("{path}.minimum"))?;
    let maximum = finite_number(object.get("maximum"), &format!("{path}.maximum"))?;
    let exclusive_minimum = finite_number(
        object.get("exclusiveMinimum"),
        &format!("{path}.exclusiveMinimum"),
    )?;
    let exclusive_maximum = finite_number(
        object.get("exclusiveMaximum"),
        &format!("{path}.exclusiveMaximum"),
    )?;
    let min_length = count(object.get("minLength"), &format!("{path}.minLength"))?;
    let max_length = count(object.get("maxLength"), &format!("{path}.maxLength"))?;
    let min_items = count(object.get("minItems"), &format!("{path}.minItems"))?;
    let max_items = count(object.get("maxItems"), &format!("{path}.maxItems"))?;
    validate_order(minimum, maximum, path, "minimum", "maximum")?;
    validate_order(
        exclusive_minimum,
        exclusive_maximum,
        path,
        "exclusiveMinimum",
        "exclusiveMaximum",
    )?;
    validate_order(min_length, max_length, path, "minLength", "maxLength")?;
    validate_order(min_items, max_items, path, "minItems", "maxItems")?;
    let (pattern, pattern_regex) =
        optional_pattern(object.get("pattern"), &format!("{path}.pattern"))?;
    let unique_items = optional_bool(object.get("uniqueItems"), &format!("{path}.uniqueItems"))?;

    Ok(SchemaAst {
        schema_type,
        properties,
        required,
        additional,
        items,
        prefix_items,
        property_names,
        enumeration,
        constant,
        any_of,
        one_of,
        all_of,
        not,
        minimum,
        maximum,
        exclusive_minimum,
        exclusive_maximum,
        min_length,
        max_length,
        pattern,
        pattern_regex,
        min_items,
        max_items,
        unique_items,
    })
}

pub(super) fn schema_error(path: impl Into<String>, message: impl Into<String>) -> ProgramError {
    ProgramError::new(ProgramErrorCode::InvalidSchema, path, message)
}
