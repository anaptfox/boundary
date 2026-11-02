use boundary_macros::Interaction;

#[derive(Interaction)]
#[interaction(id = "demo.tuple", output = String)]
struct TupleRequest(String);

fn main() {}
