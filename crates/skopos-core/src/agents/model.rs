//! The agent's model choice (native agents spec §6.2): the first `select` session config
//! option with category `model`.

use std::collections::HashSet;

use agent_client_protocol::v1::schema::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    SessionConfigSelectOptions,
};
use serde::Serialize;
use ts_rs::TS;

/// What the chat header's model picker shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelChoice {
    /// The config option's id, for `session/set_config_option`.
    pub option_id: String,
    /// The value in use. An agent may report one that is not among `choices`.
    pub current: String,
    /// In the agent's order, each value once.
    pub choices: Vec<ModelValue>,
}

/// One model the agent offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelValue {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The name of the agent's group, when it sends groups.
    pub group: Option<String>,
}

impl ModelChoice {
    /// Whether `value` is one of the choices.
    pub fn offers(&self, value: &str) -> bool {
        self.choices.iter().any(|choice| choice.id == value)
    }
}

/// The model choice among `options`: the first `select` option with category `model`, when
/// it has at least one value. Other categories, a missing category and boolean options are
/// not models.
pub fn model_choice(options: &[SessionConfigOption]) -> Option<ModelChoice> {
    let option = options.iter().find(|option| {
        option.category == Some(SessionConfigOptionCategory::Model)
            && matches!(option.kind, SessionConfigKind::Select(_))
    })?;
    let SessionConfigKind::Select(select) = &option.kind else {
        return None;
    };
    let listed: Vec<(&SessionConfigSelectOption, Option<&str>)> = match &select.options {
        SessionConfigSelectOptions::Ungrouped(values) => {
            values.iter().map(|value| (value, None)).collect()
        }
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| {
                group
                    .options
                    .iter()
                    .map(move |value| (value, Some(group.name.as_str())))
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    let choices: Vec<ModelValue> = listed
        .into_iter()
        .filter(|(value, _)| seen.insert(value.value.0.to_string()))
        .map(|(value, group)| ModelValue {
            id: value.value.0.to_string(),
            name: value.name.clone(),
            description: value.description.clone(),
            group: group.map(str::to_owned),
        })
        .collect();
    if choices.is_empty() {
        return None;
    }
    Some(ModelChoice {
        option_id: option.id.0.to_string(),
        current: select.current_value.0.to_string(),
        choices,
    })
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::v1::schema::SessionConfigOption;
    use serde_json::{json, Value};

    use super::*;

    fn options(value: Value) -> Vec<SessionConfigOption> {
        serde_json::from_value(value).unwrap()
    }

    fn ids(choice: &ModelChoice) -> Vec<&str> {
        choice
            .choices
            .iter()
            .map(|value| value.id.as_str())
            .collect()
    }

    #[test]
    fn the_first_model_select_is_the_choice() {
        let options = options(json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
              "currentValue": "ask", "options": [{ "value": "ask", "name": "Ask" }] },
            { "id": "fast", "name": "Fast mode", "category": "model", "type": "boolean",
              "currentValue": true },
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "sonnet",
              "options": [
                  { "value": "opus", "name": "Opus", "description": "Most capable" },
                  { "value": "sonnet", "name": "Sonnet" }
              ] },
            { "id": "second", "name": "Other model", "category": "model", "type": "select",
              "currentValue": "x", "options": [{ "value": "x", "name": "X" }] }
        ]));
        let choice = model_choice(&options).unwrap();
        assert_eq!(choice.option_id, "model");
        assert_eq!(choice.current, "sonnet");
        assert_eq!(ids(&choice), ["opus", "sonnet"]);
        assert_eq!(choice.choices[0].name, "Opus");
        assert_eq!(
            choice.choices[0].description.as_deref(),
            Some("Most capable")
        );
        assert_eq!(choice.choices[1].description, None);
        assert_eq!(choice.choices[0].group, None);
        assert!(choice.offers("opus"));
        assert!(!choice.offers("x"));
    }

    #[test]
    fn grouped_values_carry_their_group_s_name_and_repeats_are_dropped() {
        let options = options(json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "anthropic/opus",
              "options": [
                  { "group": "anthropic", "name": "Anthropic", "options": [
                      { "value": "anthropic/opus", "name": "Opus" },
                      { "value": "anthropic/sonnet", "name": "Sonnet" }
                  ] },
                  { "group": "openai", "name": "OpenAI", "options": [
                      { "value": "openai/gpt", "name": "GPT" },
                      { "value": "anthropic/opus", "name": "Opus again" }
                  ] }
              ] }
        ]));
        let choice = model_choice(&options).unwrap();
        assert_eq!(
            ids(&choice),
            ["anthropic/opus", "anthropic/sonnet", "openai/gpt"]
        );
        let groups: Vec<Option<&str>> = choice
            .choices
            .iter()
            .map(|value| value.group.as_deref())
            .collect();
        assert_eq!(
            groups,
            [Some("Anthropic"), Some("Anthropic"), Some("OpenAI")]
        );
        assert_eq!(choice.choices[0].name, "Opus");
    }

    #[test]
    fn no_model_option_or_an_empty_list_gives_no_choice() {
        assert_eq!(model_choice(&[]), None);
        let unnamed = options(json!([
            { "id": "model", "name": "Model", "type": "select", "currentValue": "a",
              "options": [{ "value": "a", "name": "A" }] }
        ]));
        assert_eq!(model_choice(&unnamed), None);
        let other = options(json!([
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
              "currentValue": "a", "options": [{ "value": "a", "name": "A" }] },
            { "id": "tune", "name": "Tune", "category": "model_config", "type": "select",
              "currentValue": "a", "options": [{ "value": "a", "name": "A" }] },
            { "id": "x", "name": "X", "category": "_custom", "type": "select",
              "currentValue": "a", "options": [{ "value": "a", "name": "A" }] }
        ]));
        assert_eq!(model_choice(&other), None);
        let empty = options(json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "a", "options": [] }
        ]));
        assert_eq!(model_choice(&empty), None);
    }

    #[test]
    fn a_current_value_not_in_the_list_is_kept() {
        let options = options(json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "provider/custom",
              "options": [{ "value": "provider/a", "name": "A" }] }
        ]));
        let choice = model_choice(&options).unwrap();
        assert_eq!(choice.current, "provider/custom");
        assert!(!choice.offers("provider/custom"));
        assert_eq!(ids(&choice), ["provider/a"]);
    }
}
